import test from 'node:test'
import assert from 'node:assert/strict'
import { serviceIdentityBlock } from '../../lib/serviceIdentity.mjs'
import { APP_VERSION } from '../../lib/appVersion.mjs'

test('states the running version', () => {
  assert.match(serviceIdentityBlock(), new RegExp(`version ${APP_VERSION.replace(/\./g, '\\.')}`))
})

test('collapses one model across roles into a single clause', () => {
  const block = serviceIdentityBlock({
    report: { roles: [{ role: 'planner', model: 'M/x' }, { role: 'synth', model: 'M/x' }] }
  })
  assert.match(block, /M\/x for every role/)
  assert.doesNotMatch(block, /planner: /)
})

test('lists roles separately when they differ', () => {
  const block = serviceIdentityBlock({
    report: { roles: [{ role: 'planner', model: 'A' }, { role: 'synth', model: 'B' }] }
  })
  assert.match(block, /planner: A; synth: B/)
})

test('degrades to a legible string rather than throwing', () => {
  // A report that blows up on access, which is what a broken catalogue snapshot
  // looks like from here. The prompt must still be built: "unavailable" is a
  // legible answer, a 500 on the chat route is not.
  const exploding = { get roles() { throw new Error('snapshot unavailable') } }
  const block = serviceIdentityBlock({ report: exploding })
  assert.match(block, /model resolution unavailable/)
})

test('reports no models as unavailable rather than as an empty list', () => {
  assert.match(serviceIdentityBlock({ report: { roles: [] } }), /model resolution unavailable/)
})

// The grounding audit flags unbacked numbers of four or more digits. Neither a
// semver nor the current model ids contain such a run, so the block cannot
// manufacture a GROUNDING error on every self-description.
test('carries no number the grounding audit would flag', () => {
  const block = serviceIdentityBlock({
    version: '4.2.4',
    report: { roles: [{ role: 'planner', model: 'Qwen/Qwen3.5-397B-A17B-FP8' }] }
  })
  const flagged = block.match(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{4,}(?:\.\d+)?\b/g) || []
  assert.deepEqual(flagged, [])
})
