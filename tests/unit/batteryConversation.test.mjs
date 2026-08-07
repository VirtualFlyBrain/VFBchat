// Offline unit tests for multi-turn battery logic.
// Run: node --test tests/unit/batteryConversation.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONVERSATION_TIER,
  CONVERSATION_QUALITY_FLAGS,
  SLOW_FOLLOWUP_MS,
  UNMATCHED_CLAIM_RE,
  normalizeBatteryTask,
  selectAskChip,
  chipFocus,
  checkTurn,
  classifyConversationQuality
} from '../../lib/battery/conversation.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const chip = (id, query_type, query) => ({ kind: 'ask', id, query_type, query })

test('normalizeBatteryTask: a single-question task becomes a one-turn conversation', () => {
  const task = normalizeBatteryTask({ id: 'T1.1', tier: 1, title: 'x', question: 'what is the medulla?' })
  assert.equal(task.conversation, false)
  assert.equal(task.turns.length, 1)
  assert.equal(task.turns[0].question, 'what is the medulla?')
  assert.equal(task.question, 'what is the medulla?')
})

test('normalizeBatteryTask: a turns task reports its opening question and is flagged', () => {
  const task = normalizeBatteryTask({
    id: 'C1', tier: CONVERSATION_TIER, title: 'follow-up',
    turns: [{ question: 'what is the medulla?' }, { question: 'and its parts?' }]
  })
  assert.equal(task.conversation, true)
  assert.equal(task.question, 'what is the medulla?')
  assert.equal(task.turns[1].question, 'and its parts?')
})

test('normalizeBatteryTask: a click turn keeps its index and needs no question', () => {
  const task = normalizeBatteryTask({
    id: 'C2', tier: 7, title: 'click',
    turns: [{ question: 'what is the medulla?' }, { click_followon: 2, expect: { min_followons: 1 } }]
  })
  assert.equal(task.turns[1].click_followon, 2)
  assert.equal(task.turns[1].question, '')
  assert.deepEqual(task.turns[1].expect, { min_followons: 1 })
})

test('normalizeBatteryTask: malformed tasks fail at parse time, not run time', () => {
  assert.throws(() => normalizeBatteryTask({ id: 'X', tier: 7, title: 't', turns: [] }), /must not be empty/)
  assert.throws(() => normalizeBatteryTask({ id: 'X', tier: 7, title: 't' }), /"question" or "turns"/)
  assert.throws(() => normalizeBatteryTask({ id: 'X', tier: 7, title: 't', turns: [{}] }), /needs either/)
  // The one that would otherwise burn a live model call before failing.
  assert.throws(
    () => normalizeBatteryTask({ id: 'X', tier: 7, title: 't', turns: [{ click_followon: 0 }] }),
    /cannot click a follow-on before the first answer/
  )
  assert.throws(
    () => normalizeBatteryTask({ id: 'X', tier: 7, title: 't', turns: [{ question: 'a' }, { click_followon: -1 }] }),
    /non-negative integer/
  )
})

test('selectAskChip / chipFocus: only clickable chips count, and only addressed ones post a focus', () => {
  const followOns = [
    { kind: 'link', query: 'Open medulla in VFB' },
    chip('FBbt_00003748', 'PartsOf', 'What are the anatomical parts of the medulla?'),
    { kind: 'ask', query: 'something vague' }
  ]
  assert.equal(selectAskChip(followOns, 0).query_type, 'PartsOf')
  assert.deepEqual(chipFocus(selectAskChip(followOns, 0)), { id: 'FBbt_00003748', query_type: 'PartsOf' })
  assert.equal(chipFocus(selectAskChip(followOns, 1)), null)
  assert.equal(selectAskChip(followOns, 9), null)
  assert.equal(selectAskChip(undefined, 0), null)
})

test('checkTurn: an addressless chip is caught with no expectation set at all', () => {
  const problems = checkTurn(null, { followOns: [{ kind: 'ask', query: 'Which neurons?' }] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /carry no \(id, query_type\)/)
})

test('checkTurn: a clean turn with expectations returns nothing', () => {
  const problems = checkTurn(
    { context_carries: 'medulla', context_carries_id: 'FBbt_00003748', no_unmatched_claim: true, min_followons: 2, mentions: ['medulla'] },
    {
      answer: 'VFB has 333 neuron types with postsynaptic terminals in the medulla.',
      followOns: [chip('FBbt_00003748', 'PartsOf', 'parts?'), chip('FBbt_00003748', 'NeuronsPartHere', 'arbours?')],
      context: { terms: [{ id: 'FBbt_00003748', label: 'medulla' }] }
    }
  )
  assert.deepEqual(problems, [])
})

test('checkTurn: the failure this whole feature exists to prevent', () => {
  const problems = checkTurn(
    { context_carries: 'medulla', no_unmatched_claim: true, min_followons: 1 },
    {
      answer: 'The term "medulla" was not matched to a specific VFB entity in this session.',
      followOns: [],
      context: { terms: [] }
    }
  )
  assert.equal(problems.length, 3)
  assert.match(problems.join('\n'), /does not carry "medulla"/)
  assert.match(problems.join('\n'), /claims the term was not matched/)
  assert.match(problems.join('\n'), /expected at least 1 follow-on/)
})

test('checkTurn: a chip offering back the clicked question is a failure, and only when clicked', () => {
  const observed = {
    answer: 'ok',
    followOns: [chip('FBbt_00003748', 'NeuronsPostsynapticHere', 'Which neurons receive output from the medulla?')],
    context: { terms: [] }
  }
  const clicked = checkTurn({ no_repeat_of_focus: true }, {
    ...observed, focus: { id: 'FBbt_00003748', query_type: 'neuronspostsynaptichere' }
  })
  assert.equal(clicked.length, 1)
  assert.match(clicked[0], /offers back the question just answered/)

  // Same chips, typed turn: nothing was clicked, so nothing is claimed.
  assert.deepEqual(checkTurn({ no_repeat_of_focus: true }, observed), [])

  // A different term keeps its own genuinely unasked chip.
  assert.deepEqual(
    checkTurn({ no_repeat_of_focus: true }, { ...observed, focus: { id: 'FBbt_00003852', query_type: 'NeuronsPostsynapticHere' } }),
    []
  )
})

test('checkTurn: mentions matches on word edges, not substrings', () => {
  const observed = { answer: 'The medullary cells are unrelated.', followOns: [], context: { terms: [] } }
  assert.match(checkTurn({ mentions: ['medulla'] }, observed).join(''), /never mentions "medulla"/)
  assert.deepEqual(checkTurn({ mentions: ['medullary'] }, observed), [])
  assert.match(checkTurn({ not_mentions: ['medullary'] }, observed).join(''), /should not be about/)
})

test('UNMATCHED_CLAIM_RE: matches the live wordings, not an ordinary sentence', () => {
  assert.ok(UNMATCHED_CLAIM_RE.test('The term "medulla" was not matched to a specific VFB entity in this session'))
  assert.ok(UNMATCHED_CLAIM_RE.test('that name could not be matched'))
  assert.ok(!UNMATCHED_CLAIM_RE.test('The medulla is the second optic neuropil.'))
})

test('classifyConversationQuality: a clean run raises nothing', () => {
  const flags = classifyConversationQuality({
    turns: [{ duration_ms: 10000 }, { duration_ms: 12000 }],
    expectation_problems: []
  })
  for (const name of CONVERSATION_QUALITY_FLAGS) assert.equal(flags[name], false, `${name} should be clear`)
  assert.equal(flags.slowest_followup_ms, 12000)
})

test('classifyConversationQuality: the measured 4.0.2 failure raises exactly its flags', () => {
  // The numbers are the ones observed live: turn 1 answered by the fast path in
  // 10s, turn 2 falling through to the contested planner for 381s.
  const flags = classifyConversationQuality({
    turns: [{ duration_ms: 10000 }, { duration_ms: 381000 }],
    expectation_problems: [
      'turn 2: context does not carry "medulla" (carries: nothing)',
      'turn 2: answer claims the term was not matched: "was not matched to"'
    ]
  })
  assert.equal(flags.context_lost_across_turn, true)
  assert.equal(flags.unmatched_claim_after_resolve, true)
  assert.equal(flags.slow_followup_turn, true)
  assert.equal(flags.slowest_followup_ms, 381000)
  assert.equal(flags.addressless_followon, false)
  assert.equal(flags.repeats_answered_question, false)
})

test('classifyConversationQuality: turn 1 is never the slow turn', () => {
  // A cold opening question is allowed to be slow — that is the ordinary path.
  // Only what happens AFTER a term is in hand is evidence about the warm routes.
  const flags = classifyConversationQuality({
    turns: [{ duration_ms: 400000 }, { duration_ms: 8000 }],
    expectation_problems: []
  })
  assert.equal(flags.slow_followup_turn, false)
  assert.equal(flags.slowest_followup_ms, 8000)
})

test('classifyConversationQuality: every flag is reachable from a real checkTurn problem', () => {
  // The flags read checkTurn's own wording, so a reworded problem string would
  // silently stop raising its flag. Rather than assert on hand-typed strings,
  // this drives checkTurn into each failure and classifies what it actually
  // produced — the two can only drift if this test fails.
  const raised = new Set()
  const cases = [
    [{ min_followons: 1 }, { followOns: [{ kind: 'ask', query: 'Which neurons?' }] }],
    [{ context_carries: 'medulla' }, { context: { terms: [] } }],
    [{ no_unmatched_claim: true }, { answer: 'that name could not be matched to a VFB term.' }],
    [{ no_repeat_of_focus: true }, {
      focus: { id: 'FBbt_00003748', query_type: 'PartsOf' },
      followOns: [chip('FBbt_00003748', 'PartsOf', 'What are the anatomical parts of the medulla?')]
    }]
  ]
  for (const [expect, observed] of cases) {
    const problems = checkTurn(expect, observed)
    assert.ok(problems.length > 0, `case produced no problem: ${JSON.stringify(expect)}`)
    const flags = classifyConversationQuality({ turns: [{}, {}], expectation_problems: problems })
    for (const name of CONVERSATION_QUALITY_FLAGS) if (flags[name]) raised.add(name)
  }
  raised.add('slow_followup_turn') // driven by duration, not by a problem string
  assert.deepEqual([...raised].sort(), [...CONVERSATION_QUALITY_FLAGS].sort())
})

test('the shipped tier-7 tasks are well formed and exercise the whole feature', () => {
  const tasks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests', 'task-battery', 'tasks.json'), 'utf8'))
    .map((task, i) => normalizeBatteryTask(task, i))
  const conversations = tasks.filter(t => t.tier === CONVERSATION_TIER)

  assert.ok(conversations.length >= 8, `expected a real tier-7 set, got ${conversations.length}`)
  // Every tier-7 task must actually BE a conversation, or it is sitting in the
  // wrong tier and `--tier 7` no longer means what the help text says.
  for (const task of conversations) {
    assert.equal(task.conversation, true, `${task.id} is a single question in the conversation tier`)
    assert.ok(task.turns.slice(1).some(t => t.expect), `${task.id} asserts nothing after turn 1`)
  }
  // The two things only a conversation can test must both be represented.
  assert.ok(
    conversations.some(t => t.turns.some(turn => turn.click_followon !== null)),
    'no tier-7 task clicks a follow-on chip'
  )
  assert.ok(
    conversations.some(t => t.turns.some(turn => turn.expect?.context_carries_id)),
    'no tier-7 task asserts an id survives the turn boundary'
  )
  // Ids are asserted only where they are known exactly; a wrong one would fail
  // every run for a reason that has nothing to do with the code under test.
  for (const task of conversations) {
    for (const turn of task.turns) {
      for (const id of [].concat(turn.expect?.context_carries_id || [])) {
        assert.match(id, /^(FBbt|VFB|FBgn|FBal|FBti|FBtp|FBco)_[0-9a-zA-Z]+$/, `${task.id}: implausible id ${id}`)
      }
    }
  }
  assert.ok(SLOW_FOLLOWUP_MS > 0)
})
