// The user's question must not reach the container log.
//
// governance.js stores no message text, and route.js states at the end of every
// request that "No user text and no tool payloads are logged". The promise has
// been broken three times; the third time arrived through a path the earlier
// fixes did not cover — startDocSearch passes the WHOLE user question as
// search_reviewed_docs' `query` on every non-underspecified turn, and the
// tool-failure handler logged JSON.stringify(args) with no gate at all.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { safeToolArgs } from '../../lib/safeToolArgs.mjs'

const QUESTION = 'Does the mutant line I got from Kyoto, JS-1174-b, label PAM neurons?'

test('a free-text argument is reduced to its length', () => {
  const out = safeToolArgs({ query: QUESTION, max_results: 5 }, { trace: false })
  assert.ok(!out.includes('Kyoto'), out)
  assert.ok(!out.includes('PAM'), out)
  assert.match(out, /query:<text:\d+>/)
  assert.match(out, /max_results:5/)
})

test('the arguments worth having in a log survive', () => {
  const out = safeToolArgs({ id: 'FBbt_00007053', query_type: 'TransgeneExpressionHere', limit: 25 }, { trace: false })
  assert.match(out, /id:FBbt_00007053/)
  assert.match(out, /query_type:TransgeneExpressionHere/)
  assert.match(out, /limit:25/)
})

test('a safe key carrying unexpected prose is still redacted', () => {
  // `id` is on the safe list, but a value that is not id-shaped is not an id.
  const out = safeToolArgs({ id: 'the neuron I was looking at earlier, you know the one' }, { trace: false })
  assert.match(out, /id:<text:\d+>/)
})

test('nested and array values are reported as shape only', () => {
  const out = safeToolArgs({ queries: [{ id: 'a' }, { id: 'b' }], scene: { x: 1 }, flag: true }, { trace: false })
  assert.match(out, /queries:\[2\]/)
  assert.match(out, /scene:\{…\}/)
  assert.match(out, /flag:true/)
})

test('the trace flag still gives the full arguments for debugging', () => {
  const out = safeToolArgs({ query: QUESTION }, { trace: true })
  assert.ok(out.includes('Kyoto'))
})

test('no logging site in the request path stringifies raw tool args', () => {
  // The fix keeps getting reapplied at one call site while another grows back.
  // Assert on the whole surface instead.
  for (const file of ['lib/liveHarness.mjs', 'app/api/chat/route.js']) {
    const src = fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
    for (const [i, line] of src.split('\n').entries()) {
      if (!/console\.(log|error|warn)/.test(line)) continue
      assert.ok(!/JSON\.stringify\(\s*args\s*\)/.test(line),
        `${file}:${i + 1} logs raw tool args — use safeToolArgs():\n  ${line.trim()}`)
    }
  }
})

test('malformed input never throws', () => {
  assert.equal(safeToolArgs(null, { trace: false }), '{}')
  assert.equal(safeToolArgs(undefined, { trace: false }), '{}')
  assert.equal(safeToolArgs('a string', { trace: false }), '{}')
})
