// Everything in this repo that carries a release version, in one list.
//
// The history this exists to end: v4.2.3 shipped with package.json reading
// 4.2.2 and reported itself as 4.2.2 while being entirely correct — a working
// deployment indistinguishable from a failed rollout. v4.2.5 added a CI gate
// that failed the build when the tag and package.json disagreed, which caught
// the next slip (v4.2.7) but turned it into a dead release: the gate ran before
// the push, so no image was published at all and the tagged release existed on
// GitHub with nothing behind it. RELEASE_NOTES.md, meanwhile, has been stuck at
// v4.2.2 across four releases because nothing but memory ever updated it.
//
// Failing was the wrong verb, and a maintainer knowing the list was the wrong
// mechanism. The git tag is unambiguous, so CI reads the version off it, makes
// every surface below agree, builds from that tree, and pushes the same change
// back to the default branch. Publishing a release is the whole ritual.
//
// To add a release surface, add it to RELEASE_SURFACES. Nothing in
// .github/workflows/ or scripts/ needs to change, and `--check` starts guarding
// it on the next push.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Turn a git ref or tag name into the version it releases.
 *
 * Accepts `v4.2.7`, `4.2.7`, `refs/tags/v4.2.7` and prereleases such as
 * `v4.3.0-rc.1`. Returns null for anything that is not a semver release tag,
 * which the caller treats as a mistake worth stopping for rather than guessing
 * at.
 */
export function parseReleaseTag(ref) {
  if (typeof ref !== 'string') return null
  const tag = ref.replace(/^refs\/tags\//, '').trim()
  const version = tag.replace(/^v/, '')
  return SEMVER.test(version) ? version : null
}

/**
 * Order two semver versions. Negative when `a` precedes `b`, positive when it
 * follows, 0 when they are the same release.
 *
 * Prerelease handling is deliberately shallow: any prerelease sorts before the
 * release it leads to, and two prereleases of one triple compare as strings.
 * That is enough for the only question asked of it — is this release newer than
 * what the default branch claims — without taking a semver dependency for it.
 */
export function compareVersions(a, b) {
  const left = SEMVER.exec(a)
  const right = SEMVER.exec(b)
  if (!left || !right) throw new Error(`Not a semver version: ${!left ? a : b}`)
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i])
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  const preLeft = left[4]
  const preRight = right[4]
  if (preLeft === preRight) return 0
  if (!preLeft) return 1
  if (!preRight) return -1
  return preLeft < preRight ? -1 : 1
}

/** True when `candidate` is a strictly later release than `current`. */
export function isNewerThan(candidate, current) {
  return compareVersions(candidate, current) > 0
}

// package.json and package-lock.json are npm-formatted: two-space indent,
// trailing newline. Writing them any other way turns a version bump into a
// whole-file diff.
const parseJson = (text) => JSON.parse(text)
const formatJson = (value) => `${JSON.stringify(value, null, 2)}\n`

/**
 * Render release notes as one RELEASE_NOTES.md entry, in the shape the entries
 * already there use: a `- ` bullet carrying the first line, with the rest of the
 * prose indented under it.
 */
export function formatReleaseNotesEntry(version, notes) {
  const body = (notes ?? '').replace(/\r\n/g, '\n').trim()
  const lines = body ? body.split('\n') : [`Release v${version}.`]
  const [first, ...rest] = lines
  const indented = rest.map((line) => (line.trim() ? `  ${line}` : ''))
  return [`## v${version}`, `- ${first}`, ...indented].join('\n').replace(/\n+$/, '')
}

/**
 * Every file that has to change when a release happens.
 *
 * `apply` returns the new file contents, or null when there is nothing to do —
 * so applying the same release twice is a no-op, which is what makes a re-run of
 * a release workflow safe. `check` reports what the file currently claims, so
 * `set-version.mjs --check` can fail a PR that moves one surface and not the
 * others without knowing anything about what any of them are.
 */
export const RELEASE_SURFACES = [
  {
    file: 'package.json',
    required: true,
    // The version every other surface is measured against, and what
    // lib/appVersion.mjs reads at runtime when the image sets no
    // NEXT_PUBLIC_APP_VERSION.
    check: (text) => parseJson(text).version ?? null,
    apply: (text, { version }) => {
      const pkg = parseJson(text)
      if (pkg.version === version) return null
      return formatJson({ ...pkg, version })
    },
  },
  {
    file: 'package-lock.json',
    required: true,
    // The lockfile carries the version twice. npm treats a disagreement with
    // package.json as a reason to refuse `npm ci`, so a half-applied bump breaks
    // the build rather than merely mislabelling it.
    check: (text) => {
      const lock = parseJson(text)
      const root = lock.version ?? null
      const self = lock.packages?.['']?.version ?? null
      return root === self ? root : `${root} / ${self} (disagree)`
    },
    apply: (text, { version }) => {
      const lock = parseJson(text)
      const selfPackage = lock.packages?.['']
      if (lock.version === version && (!selfPackage || selfPackage.version === version)) return null
      const next = { ...lock, version }
      if (selfPackage) {
        next.packages = { ...lock.packages, '': { ...selfPackage, version } }
      }
      return formatJson(next)
    },
  },
  {
    file: 'RELEASE_NOTES.md',
    required: false,
    // Release history in the repo, so a tag's notes survive independently of
    // GitHub. Not part of --check: it is documentation, and a PR that adds a
    // feature has no business being blocked for not having a release heading it
    // cannot know the number of yet.
    checked: false,
    check: (text) => {
      const match = /^## v(\d+\.\d+\.\d+[^\s]*)/m.exec(text)
      return match ? match[1] : null
    },
    apply: (text, { version, notes }) => {
      // Only a release has notes. A version tag pushed without one, or a hand
      // bump on a branch, must not invent a heading — and must not lay down a
      // placeholder that the release run would then find already present and
      // decline to replace. Pushing a tag fires both a `push` and a `release`
      // run, so that ordering is a live race, not a hypothetical one.
      if (!notes || !notes.trim()) return null
      // Idempotent: a re-run, or a release whose notes were written by hand,
      // must not stack a second heading for the same version.
      if (new RegExp(`^## v${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(text)) return null
      const entry = formatReleaseNotesEntry(version, notes)
      // Entries are newest-first below the `---` under the preamble.
      const separator = text.indexOf('\n---\n')
      if (separator === -1) return `${text.replace(/\s*$/, '')}\n\n${entry}\n`
      const head = text.slice(0, separator + '\n---\n'.length)
      const tail = text.slice(separator + '\n---\n'.length).replace(/^\n+/, '')
      return `${head}\n${entry}\n\n${tail}`
    },
  },
]

/** The surfaces `--check` enforces agreement across. */
export const CHECKED_SURFACES = RELEASE_SURFACES.filter((s) => s.checked !== false)
