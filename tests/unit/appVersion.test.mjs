// The version this client tells the outside world it is.
//
// Run: node --test tests/unit/appVersion.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { APP_CLIENT_NAME, APP_USER_AGENT, APP_VERSION } from '../../lib/appVersion.mjs'

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))

test('the reported version is the one in package.json', () => {
  // This is the whole point of the module: three hard-coded copies had drifted
  // to 3.3.0 / 3.2.3 / 3.2.0 and nothing failed to tell anyone.
  assert.equal(APP_VERSION, pkg.version)
  assert.notEqual(APP_VERSION, '0.0.0', 'the fallback means package.json was not found at runtime')
})

test('package-lock.json agrees with package.json', () => {
  // npm rewrites the lock's own version on install, so a bump that skips the
  // lock leaves a stale version in the artefact that actually gets deployed.
  const lock = JSON.parse(readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'))
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages['']?.version, pkg.version)
})

test('the User-Agent is the client name and version, nothing else', () => {
  assert.equal(APP_USER_AGENT, `${APP_CLIENT_NAME}/${APP_VERSION}`)
  assert.match(APP_USER_AGENT, /^vfb-chat-client\/\d+\.\d+\.\d+/)
})

test('the client name matches the package name the servers already know', () => {
  assert.equal(APP_CLIENT_NAME, pkg.name)
})
