// Two gates that were documented, tested, and not gates.
//
// 1. `priorTermQueries` says it validates a clicked chip's {id, query_type}
//    before it is run — "a chip claiming a query the term never advertised is
//    not honoured". It had a unit test and exactly one occurrence in non-test
//    code: its own definition. The live path is detectFocusPlan, which checks
//    only that the id and the query type are the right SHAPE, and then
//    dispatches. A stale chip, or any client-authored pair passing those two
//    regexes, went to the MCP, was rejected, and came back to the user as "VFB
//    does not currently hold ..." about a term the same answer hyperlinks.
//
// 2. The clarify branch returned the model's text raw and hard-coded
//    blockedResponseDomains: [], while every other exit went through
//    sanitizeAssistantOutput, sanitizeInternalToolMentions, stripHarnessFraming
//    and stripLeakedIds.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { detectFocusPlan } from '../../lib/planner.mjs'
import { createLedger, setPlan, addTerm } from '../../lib/ledger.mjs'
import { dropUnofferedTemplateSteps } from '../../lib/orchestrator.mjs'

function ledgerWithChip (queryType) {
  const ledger = createLedger('and what about it?')
  const plan = detectFocusPlan('and what about it?', { id: 'FBbt_00003748', query_type: queryType })
  assert.ok(plan, 'the chip should be shape-valid')
  setPlan(ledger, plan)
  addTerm(ledger, 'medulla', {
    id: 'FBbt_00003748',
    label: 'medulla',
    kind: 'region',
    digest: {
      id: 'FBbt_00003748',
      name: 'medulla',
      queries: [{ query_type: 'NeuronsPartHere' }, { query_type: 'PartsOf' }]
    },
    attempted: true
  })
  return ledger
}

test('a chip step is marked as client-authored so it can be re-checked', () => {
  const plan = detectFocusPlan('x', { id: 'FBbt_00003748', query_type: 'PartsOf' })
  assert.equal(plan.steps[0].via_chip, true)
  const ledger = createLedger('x')
  setPlan(ledger, plan)
  assert.equal(ledger.plan[0].via_chip, true, 'setPlan must preserve it, like via_template')
})

test('a chip claiming a query the term does not offer is withdrawn', () => {
  const ledger = ledgerWithChip('SimilarMorphologyTo')
  dropUnofferedTemplateSteps(ledger)
  assert.equal(ledger.plan.length, 0, 'the step should be gone, not dispatched')
})

test('a chip the term really does offer is left alone', () => {
  const ledger = ledgerWithChip('PartsOf')
  dropUnofferedTemplateSteps(ledger)
  assert.equal(ledger.plan.length, 1)
  assert.equal(ledger.plan[0].args.query_type, 'PartsOf')
})

test('an unresolved term is not treated as a term that lacks the query', () => {
  const ledger = createLedger('x')
  setPlan(ledger, detectFocusPlan('x', { id: 'FBbt_99999999', query_type: 'PartsOf' }))
  dropUnofferedTemplateSteps(ledger)
  assert.equal(ledger.plan.length, 1, 'unresolved is not unoffered — let the normal not-found path report it')
})

test('the clarify branch goes through the same sanitisers as every other exit', () => {
  // Structural: the branch is one return statement inside an 11k-line file, and
  // the defect was that it skipped four named functions. Assert it calls them.
  const src = fs.readFileSync(new URL('../../app/api/chat/route.js', import.meta.url), 'utf8')
  const start = src.indexOf('if (live.clarify) {')
  assert.ok(start > 0, 'clarify branch not found')
  const branch = src.slice(start, src.indexOf('\n    }', start))
  for (const fn of ['sanitizeAssistantOutput', 'sanitizeInternalToolMentions', 'stripHarnessFraming', 'stripLeakedIds']) {
    assert.ok(branch.includes(fn), `the clarify branch must call ${fn}`)
  }
  // Comments are allowed to quote the old shape; code is not.
  const code = branch.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/blockedResponseDomains:\s*\[\]/.test(code),
    'blockedResponseDomains must report what was actually blocked, not a hard-coded empty list')
})
