// The single source of the client's version string.
//
// There were three of them, and they had drifted apart: package.json said
// 3.3.0, the MCP handshake identified this client as 3.2.3, and the reviewed-
// docs fetcher sent a User-Agent of 3.2.0. Every one of those is what some
// remote service records about us — the MCP server's analytics, the fetched
// site's access log — so a version bump that only lands in package.json makes
// that telemetry quietly wrong, and it stays wrong until someone tries to
// correlate a bug report with a release and finds the versions are fiction.
//
// Resolution order:
//   1. NEXT_PUBLIC_APP_VERSION, if the deployment sets one. This is the escape
//      hatch for an image built with a tag that is not in package.json.
//   2. package.json read from the working directory. The Dockerfile sets
//      WORKDIR /app and starts `next start` from there, with package.json
//      beside it, so cwd is where it actually lives at runtime.
//   3. '0.0.0', so a packaging change degrades to an obviously-fake version
//      rather than crashing a request or, worse, reporting a plausible lie.
//
// Read with fs rather than an import or createRequire, deliberately. A bare
// `import pkg from '../package.json'` is a syntax error in plain Node without
// an import attribute, which breaks the unit tests; and createRequire against
// import.meta.url is worse than it looks, because webpack inlines that URL as
// the BUILD machine's absolute path — verified in .next/server/app/api/chat/
// route.js, where it had been frozen to the build directory. In a container
// built anywhere other than the source tree, that path does not exist and the
// version silently collapses to the fallback. fs + cwd has no build-time magic
// in it and behaves the same in dev, in tests and in the image.

import { readFileSync } from 'node:fs'
import path from 'node:path'

/** The client name every outbound identifier is built from. */
export const APP_CLIENT_NAME = 'vfb-chat-client'

function versionFromPackageJson() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
    // The name check matters: if cwd is ever somewhere unexpected, reporting a
    // completely unrelated package's version would be worse than reporting none.
    if (pkg?.name === APP_CLIENT_NAME && typeof pkg.version === 'string') return pkg.version
  } catch {
    // Fall through to the fallback — a version string is never worth a crash.
  }
  return ''
}

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || versionFromPackageJson() || '0.0.0'

/** User-Agent for outbound HTTP fetches, e.g. "vfb-chat-client/3.3.0". */
export const APP_USER_AGENT = `${APP_CLIENT_NAME}/${APP_VERSION}`
