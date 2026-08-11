import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseReleaseTag, compareVersions, isNewerThan, formatReleaseNotesEntry,
  RELEASE_SURFACES, CHECKED_SURFACES,
} from '../../lib/releaseVersion.mjs'

const surface = (file) => RELEASE_SURFACES.find((s) => s.file === file)

// The defect this file guards: a release's version lived in package.json, a
// human had to put it there before tagging, and when they did not the release
// either lied about its version (v4.2.3, which reported 4.2.2) or published
// nothing at all (v4.2.7, killed by the gate added to catch v4.2.3). The tag is
// now the source of truth and CI applies it, so the parsing below is what a
// release actually rests on.

test('a release tag is read in every form CI will hand over', () => {
  assert.equal(parseReleaseTag('v4.2.7'), '4.2.7')
  assert.equal(parseReleaseTag('4.2.7'), '4.2.7')
  assert.equal(parseReleaseTag('refs/tags/v4.2.7'), '4.2.7')
  assert.equal(parseReleaseTag('  v4.2.7  '), '4.2.7')
  assert.equal(parseReleaseTag('v4.3.0-rc.1'), '4.3.0-rc.1')
})

// Better to stop than to guess: a tag CI cannot read is a mistake worth a
// failed run, because the alternative is an image labelled with something that
// is not a version.
test('anything that is not a semver release tag is refused', () => {
  for (const bad of ['v4.2', 'main', 'release-4.2.7', 'v4.2.7.1', '', 'vlatest', null, undefined, 42]) {
    assert.equal(parseReleaseTag(bad), null, `should refuse ${String(bad)}`)
  }
})

test('versions order by triple', () => {
  assert.equal(compareVersions('4.2.7', '4.2.6'), 1)
  assert.equal(compareVersions('4.2.6', '4.2.7'), -1)
  assert.equal(compareVersions('4.2.7', '4.2.7'), 0)
  assert.equal(compareVersions('4.10.0', '4.9.9'), 1, 'numeric, not lexical')
  assert.equal(compareVersions('5.0.0', '4.99.99'), 1)
})

test('a prerelease precedes the release it leads to', () => {
  assert.equal(compareVersions('4.3.0-rc.1', '4.3.0'), -1)
  assert.equal(compareVersions('4.3.0', '4.3.0-rc.1'), 1)
  assert.equal(compareVersions('4.3.0-rc.2', '4.3.0-rc.1'), 1)
})

// The guard on the sync job. Publishing a 4.2.7 hotfix while main is already on
// 4.3.0 must not walk main backwards — but the equal case is NOT a downgrade,
// and set-version.mjs --only-if-newer has to let it through, because the second
// of the two runs a version tag fires is the one carrying the release notes.
test('only a strict downgrade is refused; equal is not a downgrade', () => {
  assert.equal(isNewerThan('4.2.7', '4.2.6'), true)
  assert.equal(isNewerThan('4.2.7', '4.2.7'), false)
  assert.equal(isNewerThan('4.2.7', '4.3.0'), false)
  assert.equal(compareVersions('4.2.7', '4.2.7') < 0, false, 'equal must fall through')
  assert.equal(compareVersions('4.2.7', '4.3.0') < 0, true, 'older must bail')
})

test('package.json is rewritten to the release, and left alone when it agrees', () => {
  const pkg = surface('package.json')
  const before = `${JSON.stringify({ name: 'vfb-chat-client', version: '4.2.6' }, null, 2)}\n`
  const after = pkg.apply(before, { version: '4.2.7' })
  assert.equal(JSON.parse(after).version, '4.2.7')
  assert.equal(JSON.parse(after).name, 'vfb-chat-client', 'nothing else is disturbed')
  assert.equal(after.endsWith('}\n'), true, 'npm formatting: trailing newline')
  assert.equal(pkg.apply(after, { version: '4.2.7' }), null, 'applying twice is a no-op')
})

// npm refuses `npm ci` when the lockfile and package.json disagree, so a bump
// that reaches one and not the other does not mislabel the build — it breaks it.
test('both of the lockfile version fields move together', () => {
  const lock = surface('package-lock.json')
  const before = `${JSON.stringify({
    name: 'vfb-chat-client',
    version: '4.2.6',
    lockfileVersion: 3,
    packages: { '': { name: 'vfb-chat-client', version: '4.2.6', dependencies: { next: '14.0.0' } } },
  }, null, 2)}\n`
  const parsed = JSON.parse(lock.apply(before, { version: '4.2.7' }))
  assert.equal(parsed.version, '4.2.7')
  assert.equal(parsed.packages[''].version, '4.2.7')
  assert.deepEqual(parsed.packages[''].dependencies, { next: '14.0.0' }, 'dependencies survive')
  assert.equal(parsed.lockfileVersion, 3)
})

test('a lockfile that half-agrees is reported as disagreeing, not as fine', () => {
  const lock = surface('package-lock.json')
  const half = JSON.stringify({ version: '4.2.7', packages: { '': { version: '4.2.6' } } })
  assert.match(lock.check(half), /disagree/)
  assert.equal(lock.apply(half, { version: '4.2.7' }) !== null, true, 'and is repaired')
})

// RELEASE_NOTES.md sat at v4.2.2 through four releases because only memory ever
// updated it. The release body is now written in by CI.
test('release notes gain an entry at the top, below the preamble', () => {
  const notes = surface('RELEASE_NOTES.md')
  const before = '# Release Notes\n\nPreamble.\n\n---\n\n## v4.2.6\n- Release v4.2.6: previous.\n'
  const after = notes.apply(before, { version: '4.2.7', notes: 'Release v4.2.7: the thing.\n\nDetail.' })
  assert.match(after, /^# Release Notes/)
  assert.equal(after.indexOf('## v4.2.7') < after.indexOf('## v4.2.6'), true, 'newest first')
  assert.match(after, /- Release v4\.2\.7: the thing\./)
  assert.match(after, /\n {2}Detail\./, 'continuation prose is indented under the bullet')
  assert.match(after, /## v4\.2\.6\n- Release v4\.2\.6: previous\./, 'the existing entry is intact')
})

// A release workflow that is re-run — which is exactly what recovering a failed
// release means — must not stack a second heading for the same version.
test('applying the same release twice adds one entry', () => {
  const notes = surface('RELEASE_NOTES.md')
  const before = '# Release Notes\n\n---\n\n## v4.2.6\n- old\n'
  const once = notes.apply(before, { version: '4.2.7', notes: 'New.' })
  assert.equal(notes.apply(once, { version: '4.2.7', notes: 'New.' }), null)
})

// Pushing a version tag fires the workflow twice, once for the push and once
// for the release, and only the release carries a body. If the push run wrote a
// placeholder heading first, the release run would find it already there and
// decline to replace it — the real notes lost to a race.
test('no notes means no entry, so the release run is the one that writes them', () => {
  const notes = surface('RELEASE_NOTES.md')
  const before = '# Release Notes\n\n---\n\n## v4.2.6\n- old\n'
  assert.equal(notes.apply(before, { version: '4.2.7' }), null)
  assert.equal(notes.apply(before, { version: '4.2.7', notes: '' }), null)
  assert.equal(notes.apply(before, { version: '4.2.7', notes: '   \n' }), null)
  assert.notEqual(notes.apply(before, { version: '4.2.7', notes: 'Real notes.' }), null)
})

test('an entry with an empty body falls back to naming the release', () => {
  assert.equal(formatReleaseNotesEntry('4.2.7', ''), '## v4.2.7\n- Release v4.2.7.')
})

// The point of the manifest: --check enforces agreement, and RELEASE_NOTES.md is
// deliberately outside it, because a feature PR cannot know the version it will
// eventually ship under and must not be blocked for lacking a heading for it.
test('the checked surfaces are the machine-readable ones only', () => {
  assert.deepEqual(CHECKED_SURFACES.map((s) => s.file), ['package.json', 'package-lock.json'])
  assert.equal(RELEASE_SURFACES.every((s) => typeof s.apply === 'function' && typeof s.check === 'function'), true)
})
