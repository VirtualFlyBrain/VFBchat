// GET /api/version — what is actually deployed here.
//
// Exists because a running container's version was not checkable from outside.
// When virtualflybrain/vfbchat:3.4 briefly 404'd at the registry the only way to
// tell whether the herd container had picked up the new image was to ask it a
// question and judge the answer, which confuses "the deployment is stale" with
// "the model wrote something different this time". This endpoint answers it
// directly, and cheaply enough to poll from a healthcheck.
//
// Deliberately says nothing about the environment beyond the version, the client
// name and which MCP it is pointed at: no secrets, no header echo, nothing that
// would make an unauthenticated endpoint worth probing. VFB_MCP_URL is a public
// service address and is already visible in every answer's provenance.

// Plain Response rather than NextResponse: the App Router accepts a standard
// Response from a route handler, and `next/server` does not resolve outside the
// Next build, so importing it would make this route untestable under plain
// `node --test` — which is exactly where the "did the version wire through?"
// assertion belongs.
import { APP_VERSION, APP_CLIENT_NAME, APP_USER_AGENT } from '../../../lib/appVersion.mjs'

// Read at request time, not module load, so a redeploy that only changes the env
// is reflected without a rebuild — and so the value cannot be frozen into the
// webpack bundle the way createRequire(import.meta.url) was.
const DEFAULT_VFB_MCP_URL = 'https://vfb3-mcp-preview.virtualflybrain.org/'

export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json({
    name: APP_CLIENT_NAME,
    version: APP_VERSION,
    user_agent: APP_USER_AGENT,
    // '0.0.0' is the deliberate fallback in lib/appVersion.mjs — surface it as a
    // flag rather than leaving a caller to recognise the sentinel themselves.
    version_resolved: APP_VERSION !== '0.0.0',
    mcp_url: process.env.VFB_MCP_URL || DEFAULT_VFB_MCP_URL,
    node: process.version
  }, {
    // A cached answer here is worse than no answer: the whole point is telling a
    // stale deployment from a fresh one, and an intermediary holding the previous
    // version would say precisely the wrong thing.
    headers: { 'cache-control': 'no-store' }
  })
}
