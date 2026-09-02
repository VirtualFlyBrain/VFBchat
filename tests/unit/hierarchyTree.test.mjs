// Ontology trees for "show me the hierarchy of X" questions (issue #48).
// The fixture is the live get_hierarchy(FBbt_00003686, subclass_of,
// descendants, max_depth 2) payload, abridged. Run: node --test tests/unit/hierarchyTree.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHierarchy, summariseHierarchy, renderHierarchyMarkdown, hierarchyNodes } from '../../lib/hierarchyTree.mjs'
import { maybeInjectHierarchyStep, stripRelationalPrefix, nameVariants, pickQueriesByIntent } from '../../lib/orchestrator.mjs'
import { questionKinds } from '../../lib/queryTypes.mjs'

const KC = {
  tool: 'vfb_get_hierarchy', id: 'FBbt_00003686', label: 'Kenyon cell', relationship: 'subclass_of',
  descendants: [
    { id: 'FBbt_00049825', label: 'adult Kenyon cell', descendants: [
      { id: 'FBbt_00047926', label: 'Kenyon cell of main calyx' },
      { id: 'FBbt_00049834', label: "adult alpha'/beta' Kenyon cell" },
      { id: 'FBbt_00100248', label: 'alpha/beta Kenyon cell' }
    ] },
    { id: 'FBbt_00100247', label: 'gamma Kenyon cell', descendants: [
      { id: 'FBbt_00049828', label: 'adult gamma Kenyon cell' },
      { id: 'FBbt_00049827', label: 'larval gamma Kenyon cell' }
    ] },
    { id: 'FBbt_00047993', label: 'single-claw Kenyon cell' }
  ]
}

test('the tree is read, counted, and every node is registered once', () => {
  const tree = parseHierarchy(KC)
  assert.equal(tree.label, 'Kenyon cell')
  assert.equal(tree.descendants.length, 3)
  assert.equal(hierarchyNodes(tree).length, 8)
  assert.equal(parseHierarchy({ id: 'x', label: 'x', descendants: [] }), null)
  assert.equal(parseHierarchy(null), null)
})

test('the claim gives the direct subtypes and the size of the tree', () => {
  const s = summariseHierarchy(parseHierarchy(KC))
  assert.match(s.claim, /3 direct subtypes under Kenyon cell, 8 subtypes in all across 2 levels: adult Kenyon cell, gamma Kenyon cell, single-claw Kenyon cell/)
  assert.equal(s.directCount, 3)
  assert.equal(s.totalCount, 8)
})

test('the rendered tree is a nested, linked list, capped with an honest note', () => {
  const md = renderHierarchyMarkdown(parseHierarchy(KC))
  assert.match(md, /^\*\*Subtypes of Kenyon cell\*\* \(8 in VFB's ontology, 2 levels shown\)/)
  assert.match(md, /\n- \[Kenyon cell\]\(https:\/\/www\.virtualflybrain\.org\/reports\/FBbt_00003686\)\n\t- \[adult Kenyon cell\]\(.*FBbt_00049825\)\n\t\t- \[Kenyon cell of main calyx\]/)
  const capped = renderHierarchyMarkdown(parseHierarchy(KC), { maxNodes: 2 })
  assert.match(capped, /… and 6 more not shown/)
})

test('ancestors render as a chain ending at the term', () => {
  const tree = parseHierarchy({ id: 'FBbt_00100248', label: 'alpha/beta Kenyon cell', relationship: 'subclass_of',
    ancestors: [{ id: 'FBbt_00049825', label: 'adult Kenyon cell', ancestors: [{ id: 'FBbt_00003686', label: 'Kenyon cell' }] }] })
  const s = summariseHierarchy(tree)
  assert.match(s.claim, /alpha\/beta Kenyon cell is a subtype of adult Kenyon cell, which is a subtype of Kenyon cell/)
  assert.match(renderHierarchyMarkdown(tree), /- \[adult Kenyon cell\].*\n\t- \[Kenyon cell\].*\n\t\t- \*\*alpha\/beta Kenyon cell\*\*/)
})

test('a hierarchy question on a class with subclasses injects the tree step', () => {
  const kc = { id: 'FBbt_00003686', label: 'Kenyon cell', digest: { name: 'Kenyon cell', queries: [{ query_type: 'SubclassesOf' }, { query_type: 'ListAllAvailableImages' }] }, info: { SuperTypes: ['Class', 'Neuron', 'has_subClass'] } }
  const l = { plan: [], terms: { x: kc } }
  maybeInjectHierarchyStep(l, 'show me the hierarchy of Kenyon cell subtypes')
  assert.equal(l.plan.length, 1)
  assert.deepEqual(l.plan[0].args, { id: 'FBbt_00003686', relationship: 'subclass_of', direction: 'descendants', max_depth: 2 })
  const deep = { plan: [], terms: { x: kc } }
  maybeInjectHierarchyStep(deep, 'what is the full classification tree under Kenyon cell?')
  assert.equal(deep.plan[0].args.max_depth, 3)
  // A region asked for its parts gets part_of.
  const mb = { id: 'FBbt_00005801', label: 'mushroom body', digest: { name: 'mushroom body', queries: [{ query_type: 'PartsOf' }] }, info: { SuperTypes: ['Class', 'Anatomy', 'Synaptic_neuropil'] } }
  const parts = { plan: [], terms: { x: mb } }
  maybeInjectHierarchyStep(parts, 'what are the parts of the mushroom body?')
  assert.equal(parts.plan[0].args.relationship, 'part_of')
  // No tree wording: nothing. A class with no subclasses: nothing.
  const none = { plan: [], terms: { x: kc } }
  maybeInjectHierarchyStep(none, 'what is a Kenyon cell?')
  assert.equal(none.plan.length, 0)
  const leaf = { plan: [], terms: { x: { ...kc, digest: { name: 'x', queries: [] }, info: { SuperTypes: ['Class', 'Neuron'] } } } }
  maybeInjectHierarchyStep(leaf, 'what subtypes of x are there?')
  assert.equal(leaf.plan.length, 0)
})

test('the relation the planner copied into the term name is stripped as a retry variant', () => {
  assert.equal(stripRelationalPrefix('hierarchy of Kenyon cell subtypes'), 'Kenyon cell')
  assert.equal(stripRelationalPrefix('the subtypes of the medulla'), 'medulla')
  assert.equal(stripRelationalPrefix('anatomical parts of the medulla'), '')
  assert.equal(stripRelationalPrefix('Kenyon cell'), '')
  assert.ok(nameVariants('hierarchy of Kenyon cell subtypes').includes('Kenyon cell'))
})

test('"show me" alone is not an image request', () => {
  assert.ok(!questionKinds('show me the hierarchy of Kenyon cell subtypes').has('individual_images'))
  assert.ok(questionKinds('show me images of DA1_lPN_R').has('individual_images'))
  const digest = { name: 'Kenyon cell', queries: [
    { query_type: 'ListAllAvailableImages', label: 'List all available images of Kenyon cell', kind: 'individual_images' },
    { query_type: 'SubclassesOf', label: 'Subclasses of Kenyon cell', kind: 'class_list' }
  ] }
  const picked = pickQueriesByIntent('show me the hierarchy of Kenyon cell subtypes', digest).map(q => q.query_type)
  assert.deepEqual(picked, ['SubclassesOf'])
  assert.deepEqual(pickQueriesByIntent('show me images of Kenyon cells', digest).map(q => q.query_type), ['ListAllAvailableImages'])
})
