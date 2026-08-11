#!/usr/bin/env node
// Apply a release to every file in this repo that carries a version.
//
// Nobody should have to know what that list is. It lives in one place —
// RELEASE_SURFACES in lib/releaseVersion.mjs — and this script walks it, so a
// release is applied the same way whether it is being built, being recorded on
// the default branch, or being checked on a pull request.
//
//   node scripts/set-version.mjs 4.2.7                 # make every surface say 4.2.7
//   node scripts/set-version.mjs 4.2.7 --only-if-newer # ...unless the repo is already ahead
//   node scripts/set-version.mjs --check               # do they all already agree?
//
// --notes-file adds the release body to RELEASE_NOTES.md, so the tag's own
// description becomes the repository's release history without anyone
// transcribing it.
//
// --only-if-newer is the guard against a hotfix or a re-published old release
// walking the default branch backwards.
//
// Writes changed / version / previous / files to $GITHUB_OUTPUT under Actions.
// A no-op is a success; only a real problem exits non-zero.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  parseReleaseTag, compareVersions, RELEASE_SURFACES, CHECKED_SURFACES,
} from '../lib/releaseVersion.mjs'

// Hand-rolled rather than node:util parseArgs so the one option that takes a
// value cannot swallow the positional version argument, which is exactly the
// class of mistake this whole script exists to stop.
const VALUE_OPTIONS = new Set(['notes-file'])
const flags = new Set()
const options = new Map()
const positional = []
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  if (!arg.startsWith('--')) { positional.push(arg); continue }
  const [name, inline] = arg.slice(2).split(/=(.*)/s)
  if (!VALUE_OPTIONS.has(name)) { flags.add(name); continue }
  options.set(name, inline !== undefined ? inline : process.argv[++i])
}
const flag = (name) => flags.has(name)
const option = (name) => options.get(name)

const root = process.cwd()
const resolve = (file) => path.join(root, file)
const read = (file) => readFileSync(resolve(file), 'utf8')

const fail = (message) => {
  console.error(`set-version: ${message}`)
  process.exit(1)
}

const emit = (fields) => {
  if (!process.env.GITHUB_OUTPUT) return
  const body = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n')
  appendFileSync(process.env.GITHUB_OUTPUT, `${body}\n`)
}

// --check: every surface that claims a version must claim the same one. This is
// what catches a hand-edited package.json whose lockfile was not touched,
// before a release turns it into a broken `npm ci`.
if (flag('check')) {
  const claims = CHECKED_SURFACES
    .filter((surface) => existsSync(resolve(surface.file)) || surface.required)
    .map((surface) => {
      if (!existsSync(resolve(surface.file))) fail(`${surface.file} is missing but required`)
      return { file: surface.file, version: surface.check(read(surface.file)) }
    })
  const expected = claims[0]?.version
  const disagreeing = claims.filter((c) => c.version !== expected)
  for (const claim of claims) console.log(`  ${claim.file}: ${claim.version}`)
  if (disagreeing.length) {
    fail(
      `release surfaces disagree — ${claims.map((c) => `${c.file} says ${c.version}`).join(', ')}. `
      + `Run: node scripts/set-version.mjs ${expected}`,
    )
  }
  console.log(`All release surfaces agree at ${expected}.`)
  emit({ version: expected })
  process.exit(0)
}

const requested = positional[0]
const version = parseReleaseTag(requested ?? '')
if (!version) {
  fail(`'${requested ?? ''}' is not a vX.Y.Z version. Usage: set-version.mjs <version> [--only-if-newer] [--notes-file <path>] | --check`)
}

const pkgFile = RELEASE_SURFACES[0]
const current = pkgFile.check(read(pkgFile.file))

// --only-if-newer refuses a downgrade, and only a downgrade. The equal case has
// to fall through: pushing a version tag fires the release workflow twice, the
// first run applies the version and the second is the one carrying the release
// notes, so bailing on "already at this version" would drop the notes every
// time.
if (flag('only-if-newer') && current && compareVersions(version, current) < 0) {
  console.log(`package.json is ${current}, which is ahead of ${version}; leaving every surface alone.`)
  emit({ changed: false, version, previous: current, files: '' })
  process.exit(0)
}

const notesPath = option('notes-file')
const notes = notesPath && existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : undefined
const release = { version, notes }

const written = []
for (const surface of RELEASE_SURFACES) {
  if (!existsSync(resolve(surface.file))) {
    if (surface.required) fail(`${surface.file} is missing but required`)
    console.log(`  ${surface.file}: absent, skipped`)
    continue
  }
  const next = surface.apply(read(surface.file), release)
  if (next === null) {
    console.log(`  ${surface.file}: already correct`)
    continue
  }
  writeFileSync(resolve(surface.file), next)
  written.push(surface.file)
  console.log(`  ${surface.file}: updated`)
}

if (!written.length) {
  console.log(`Every release surface already reads ${version}.`)
  emit({ changed: false, version, previous: current, files: '' })
  process.exit(0)
}

console.log(`Applied release ${version} (was ${current}) to ${written.length} file(s).`)
emit({ changed: true, version, previous: current, files: written.join(' ') })
