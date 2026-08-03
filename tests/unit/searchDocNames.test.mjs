// The display-string defect on the legacy relay loop's side of the house.
//
// lib/orchestrator.mjs was corrected first, because that is where "What genes
// are expressed in Kenyon cells?" went wrong. But the same misreading sat in
// every search-document scorer in app/api/chat/route.js, which is the path the
// tool-calling loop takes, and the consequences there are the same:
//
//   label "Kenyon cell (FBbt_00003686)"                original_label "Kenyon cell"
//   label "Kenyon cells (gamma lobe) (gamma Kenyon cell)"
//                                        original_label "gamma Kenyon cell"
//
// `label` is a display string — the string that matched, then the term's own
// label in parentheses, or the term's short_form when the matched string WAS the
// label — and there is no `synonym` field at all.
//
// So scoreSearchDocForConnectivityEndpoint's +220 exact-name bonus could never
// be awarded to any document in any question, and its +180 synonym bonus was
// scoring an always-empty array. Endpoints were chosen on token overlap and
// facet bumps alone. Worse, the parenthetical feeds the shape tests too: a
// neuron class whose display string happens to read "(gamma lobe)" contains
// "lobe" and not "neuron", so it took the -100 penalty written for neuropil
// regions.
//
// Run: node --test tests/unit/searchDocNames.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  getSearchDocName,
  getSearchDocAltNames,
  scoreSearchDocForConnectivityEndpoint,
  pickBestConnectivityEndpointDoc,
  scoreSearchDocForNeuronTypeQuestion,
  isSearchDocProbableNeuronClass
} from '../../app/api/chat/route.js'

// Fields copied from a real search_terms response, trimmed to what is read.
const NAMED = { label: 'Kenyon cell (FBbt_00003686)', original_label: 'Kenyon cell', short_form: 'FBbt_00003686', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] }
const GAMMA = { label: 'Kenyon cells (gamma lobe) (gamma Kenyon cell)', original_label: 'gamma Kenyon cell', short_form: 'FBbt_00100247', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] }
const ACA = { label: 'Kenyon cell (ACA) (alpha/beta posterior Kenyon cell)', original_label: 'alpha/beta posterior Kenyon cell', short_form: 'FBbt_00110931', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] }
const BRACKETED = { label: 'alpha/beta c(i) Kenyon cell (alpha/beta inner-core Kenyon cell)', original_label: 'alpha/beta inner-core Kenyon cell', short_form: 'FBbt_00049111', facets_annotation: ['Entity', 'Class', 'Neuron', 'Anatomy', 'Cell'] }

test('the name is original_label, and label is not a name', () => {
  assert.equal(getSearchDocName(NAMED), 'Kenyon cell')
  assert.equal(getSearchDocName(GAMMA), 'gamma Kenyon cell')
  // A document with no original_label at all still has to yield something.
  assert.equal(getSearchDocName({ label: 'medulla' }), 'medulla')
  assert.equal(getSearchDocName({}), '')
})

test('the string that matched becomes an alternative name', () => {
  // "Kenyon cell (ACA)" is how FlyBase writes that subtype. It is what a user
  // types, and the display string is the only place it appears — there is no
  // synonym field on these documents.
  assert.deepEqual(getSearchDocAltNames(ACA), ['Kenyon cell (ACA)'])
  // When the parenthetical is the short_form, the matched string IS the name, so
  // it contributes nothing: nobody types "Kenyon cell (FBbt_00003686)".
  assert.deepEqual(getSearchDocAltNames(NAMED), [])
})

test('an alternative is recovered from a label carrying its own brackets', () => {
  // Stripping the LAST "(" rather than the balanced one would invent the
  // alternative name "alpha/beta c".
  assert.deepEqual(getSearchDocAltNames(BRACKETED), ['alpha/beta c(i) Kenyon cell'])
})

// --- what that was costing the scorers ---------------------------------------

test('the connectivity scorer can award its exact-name bonus at all', () => {
  // The bonus is +220 and it had never been awarded to any document, because no
  // term is literally called "Kenyon cell (FBbt_00003686)". Asserted as a gap
  // rather than an absolute: the subtype legitimately collects the containment
  // and token-overlap credit too, so the margin is the +220 net of those.
  const named = scoreSearchDocForConnectivityEndpoint(NAMED, 'Kenyon cell')
  const subtype = scoreSearchDocForConnectivityEndpoint(GAMMA, 'Kenyon cell')
  assert.ok(named - subtype > 150, `expected the exact name to dominate, got ${named} vs ${subtype}`)
})

test('the connectivity scorer credits the string that matched', () => {
  // Someone typing the FlyBase form should reach the subtype it names, not the
  // general class that merely shares its words.
  const aca = scoreSearchDocForConnectivityEndpoint(ACA, 'Kenyon cell (ACA)')
  const general = scoreSearchDocForConnectivityEndpoint(NAMED, 'Kenyon cell (ACA)')
  assert.ok(aca > general, `expected the named subtype to win, got ${aca} vs ${general}`)
})

test('the connectivity endpoint picked is the term that was named', () => {
  // Deliberately not first in the list — rank order is what this used to fall
  // back on once no exact stage could fire.
  assert.equal(pickBestConnectivityEndpointDoc([ACA, GAMMA, NAMED, BRACKETED], 'Kenyon cell')?.short_form, 'FBbt_00003686')
  assert.equal(pickBestConnectivityEndpointDoc([NAMED, GAMMA, ACA], 'gamma Kenyon cell')?.short_form, 'FBbt_00100247')
})

test('a neuron class is not penalised for the words in its display string', () => {
  // "Kenyon cells (gamma lobe) (gamma Kenyon cell)" contains "lobe" and does not
  // contain "neuron", so read as a name it took the -100 penalty meant for
  // neuropil regions and missed the +80 for naming a neuron — on a document
  // whose actual name is "gamma Kenyon cell" and whose facets say Neuron.
  const cell = scoreSearchDocForNeuronTypeQuestion(GAMMA, 'gamma Kenyon cell', 0)
  const region = scoreSearchDocForNeuronTypeQuestion(
    { label: 'gamma lobe (FBbt_00013694)', original_label: 'gamma lobe', short_form: 'FBbt_00013694', facets_annotation: ['Entity', 'Class', 'Anatomy', 'Synaptic_neuropil'] },
    'gamma Kenyon cell', 1
  )
  assert.ok(cell > region, `expected the neuron class to outrank the neuropil, got ${cell} vs ${region}`)
})

test('probable-neuron-class reads the name for its fallback', () => {
  // The facet path decides most documents; this is the shape fallback for the
  // ones without a Neuron facet, and it was reading the parenthetical.
  const noFacets = { label: 'lobula plate tangential neuron (FBbt_00003682)', original_label: 'lobula plate tangential neuron', short_form: 'FBbt_00003682', facets_annotation: ['Entity', 'Class'] }
  assert.equal(isSearchDocProbableNeuronClass(noFacets), true)
  const region = { label: 'medulla (FBbt_00003748)', original_label: 'medulla', short_form: 'FBbt_00003748', facets_annotation: ['Entity', 'Class'] }
  assert.equal(isSearchDocProbableNeuronClass(region), false)
})
