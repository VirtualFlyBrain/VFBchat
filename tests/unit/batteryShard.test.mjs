// Sharding the battery across matrix jobs.
//
// The battery's cost grows super-linearly with questions in flight inside one
// server process (one measured at ~143 MB peak, four at ~6.8 GB), so the way to
// make it faster is more PROCESSES, not more concurrency — and every GitHub
// Actions matrix job is a fresh runner with its own RAM. This file pins the
// properties the split has to have for that to work.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// The runner is a script, not a module, so exercise shardTasks the way the
// script does: through the CLI, on the real task file.
const RUNNER = new URL('../../scripts/run-task-battery.mjs', import.meta.url).pathname
const TASKS = new URL('../../tests/task-battery/tasks.json', import.meta.url).pathname

function shardIds(spec, total) {
  const out = execFileSync('node', ['-e', `
    import('node:fs').then(async fs => {
      const tasks = JSON.parse(fs.readFileSync(${JSON.stringify(TASKS)}, 'utf8'))
      const src = fs.readFileSync(${JSON.stringify(RUNNER)}, 'utf8')
      const body = src.slice(src.indexOf('function shardTasks'), src.indexOf('function selectTasks'))
      const shardTasks = new Function(body + '; return shardTasks')()
      console.log(JSON.stringify(shardTasks(tasks, ${JSON.stringify(spec)}).map(t => t.id)))
    })
  `], { encoding: 'utf8' })
  return JSON.parse(out.trim().split('\n').pop())
}

const ALL = shardIds('', 1)

test('the shards partition the battery exactly — nothing lost, nothing run twice', () => {
  for (const n of [2, 4, 8]) {
    const seen = []
    for (let i = 1; i <= n; i++) seen.push(...shardIds(`${i}/${n}`, n))
    assert.equal(seen.length, ALL.length, `${n} shards must cover every task once`)
    assert.deepEqual([...seen].sort(), [...ALL].sort(), `${n} shards must cover the same set`)
  }
})

test('the shards are balanced to within one task', () => {
  // An unbalanced split makes the run as long as its biggest shard, which is the
  // whole thing this is trying to avoid.
  for (const n of [2, 4, 8]) {
    const sizes = []
    for (let i = 1; i <= n; i++) sizes.push(shardIds(`${i}/${n}`, n).length)
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1,
      `${n} shards were ${sizes.join('/')}, which is not balanced`)
  }
})

test('the heavy conversation tier is spread across shards, not piled into one', () => {
  // Contiguous slicing puts all twelve tier-7 multi-turn cases in one shard and
  // the run is then as long as that shard. This is the property that makes the
  // split worth doing rather than just tidy.
  const n = 4
  const counts = []
  for (let i = 1; i <= n; i++) counts.push(shardIds(`${i}/${n}`, n).filter(id => id.startsWith('C')).length)
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1,
    `tier-7 cases landed ${counts.join('/')} across shards`)
})

test('a shard is deterministic, so a failing shard can be re-run', () => {
  assert.deepEqual(shardIds('3/8', 8), shardIds('3/8', 8))
})

test('no shard spec means the whole battery, and a bad one is refused', () => {
  assert.equal(shardIds('', 1).length, ALL.length)
  assert.equal(shardIds('1/1', 1).length, ALL.length)
  for (const bad of ['0/4', '5/4', '2/0']) {
    assert.throws(() => shardIds(bad, 4), `"${bad}" must be refused`)
  }
  // "x/4" does not match the i/n shape at all, so it is not a shard spec and the
  // whole list runs — the same as passing nothing. Refusing it would make a typo
  // in an unrelated flag silently fatal.
  assert.equal(shardIds('x/4', 4).length, ALL.length)
})
