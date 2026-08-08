// A split-GAL4 is not a GAL4 line, and the difference is the whole answer.
//
// Production v4.2.0, asked "What split-GAL4 lines label the lateral horn?" five
// times, ran TransgeneExpressionHere on the adult lateral horn and wrote:
//
//   "This set includes multiple split-GAL4 lines, such as P{GMR11B09-GAL4},
//    P{GMR13A07-GAL4}, P{GMR13F02-GAL4} ..."
//
// Those are Janelia GMR enhancer-fragment GAL4 lines. A split-GAL4 is an
// intersection of two hemidrivers. Checked against the live MCP, FBbt_00007053
// offers eleven query types and SplitsTargeting is not among them — it exists on
// neuron classes (Kenyon cell has it). So VFB holds no split-specific data for
// that region, and the honest answer says so.
//
// Two things made it impossible to answer correctly: SplitsTargeting was absent
// from QUERY_SEMANTICS, so it classified as kind 'other', which no intent rule
// mentions and pickQueriesByIntent could therefore never select on any term.

import test from 'node:test'
import assert from 'node:assert/strict'
import { querySemantics, isSplitGal4Question, isDriverLineQuestion } from '../../lib/queryTypes.mjs'
import { selectCards } from '../../lib/guidanceCards.mjs'

test('SplitsTargeting is a query type the router can actually see', () => {
  const s = querySemantics('SplitsTargeting')
  assert.equal(s.kind, 'splits')
  assert.notEqual(s.kind, 'other', 'kind "other" is unreachable — no intent rule names it')
  assert.match(s.countNoun, /split/i)
})

test('a splits query is a different kind from a transgene-expression query', () => {
  // Conflating them is what let GMR GAL4 lines be reported as split-GAL4.
  assert.notEqual(querySemantics('SplitsTargeting').kind, querySemantics('TransgeneExpressionHere').kind)
})

test('split questions are recognised, and plain driver questions are not split questions', () => {
  assert.ok(isSplitGal4Question('What split-GAL4 lines label the lateral horn?'))
  assert.ok(isSplitGal4Question('list split-GAL4s that hit the fan-shaped body'))
  assert.ok(isSplitGal4Question('any hemidriver combinations for DNp09?'))
  assert.equal(isSplitGal4Question('which GAL4 labels PAM neurons specifically'), false)
  assert.equal(isSplitGal4Question('R60D05 expression pattern'), false)
  // A split question is still a driver-line question — the split rule is a
  // narrower one that runs first, not a replacement.
  assert.ok(isDriverLineQuestion('What split-GAL4 lines label the lateral horn?'))
})

test('the split-GAL4 card fires on a split question and states the region caveat', () => {
  const cards = selectCards('What split-GAL4 lines label the lateral horn?')
  const ids = cards.map(c => c.id)
  assert.ok(ids.includes('split-gal4'), `expected split-gal4 card, got ${ids.join(', ')}`)
  const card = cards.find(c => c.id === 'split-gal4')
  assert.match(card.planner, /SplitsTargeting/)
  assert.match(card.planner, /NEURON CLASSES/)
  assert.match(card.planner, /NOT split-GAL4/i)
})

test('the split card comes before the general genetic-tools card', () => {
  // Ordering is load-bearing: the genetic-tools card matches the bare word
  // "split" and sends the planner to TransgeneExpressionHere. The last thing
  // read wins, so the narrower card has to be read after... and the general one
  // has to not be the only one present.
  const ids = selectCards('What split-GAL4 lines label the lateral horn?').map(c => c.id)
  assert.ok(ids.indexOf('split-gal4') < ids.indexOf('genetic-tools'),
    `split-gal4 should precede genetic-tools, got ${ids.join(', ')}`)
})

test('the split card stays out of questions it was not written for', () => {
  // The negative matrix is the assertion that catches regressions: a card that
  // fires on every question costs every answer.
  for (const q of [
    'What is the ellipsoid body?',
    'Which neurons have part of them in the medulla?',
    'What neurotransmitter do Kenyon cells use?',
    'How many neurons are in the adult central brain?',
    'which GAL4 labels PAM neurons specifically',
    'genes enriched in KC alpha/beta posterior'
  ]) {
    const ids = selectCards(q).map(c => c.id)
    assert.ok(!ids.includes('split-gal4'), `split-gal4 should not fire on "${q}" (got ${ids.join(', ')})`)
  }
})
