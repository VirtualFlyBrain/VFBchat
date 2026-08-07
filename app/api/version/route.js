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
// name, which MCP it is pointed at, and which model each role RESOLVED to: no
// secrets, no env echo, no header echo, nothing that would make an
// unauthenticated endpoint worth probing. VFB_MCP_URL is a public service
// address and is already visible in every answer's provenance.
//
// The resolved models are here because v4.0.0 shipped without them and the gap
// showed immediately: the version told us the IMAGE was fresh while the question
// nobody could answer from outside was which model was actually answering. That
// gap is not cosmetic — a deployment whose ELM_MODEL still names Llama runs the
// new code at v3.x sampling with no reasoning planner, answers every request
// successfully, and looks identical from here. Confirming it took a behavioural
// probe: ask a question, judge the prose, guess. Exactly the confusion between
// "the deployment is stale" and "the model wrote something different this time"
// that this endpoint was built to end, one layer down.
//
// Model NAMES, never model configuration. A gateway model id is public — it is
// in every /v1/models response the gateway serves — whereas ELM_API_KEY, the
// gateway URL and the raw env are not, and none of them appear below. The
// warnings are the same strings already printed to the container log at startup;
// they name env VARIABLES, never their values.

// Plain Response rather than NextResponse: the App Router accepts a standard
// Response from a route handler, and `next/server` does not resolve outside the
// Next build, so importing it would make this route untestable under plain
// `node --test` — which is exactly where the "did the version wire through?"
// assertion belongs.
import { APP_VERSION, APP_CLIENT_NAME, APP_USER_AGENT } from '../../../lib/appVersion.mjs'
import { describeRoleModels } from '../../../lib/roleProfiles.mjs'
import { servedModelsSnapshot, catalogueStatus } from '../../../lib/modelCatalogue.mjs'

// Read at request time, not module load, so a redeploy that only changes the env
// is reflected without a rebuild — and so the value cannot be frozen into the
// webpack bundle the way createRequire(import.meta.url) was.
const DEFAULT_VFB_MCP_URL = 'https://vfb3-mcp-preview.virtualflybrain.org/'

export const dynamic = 'force-dynamic'

/**
 * Which model each role resolved to, and whether that is the profile this build
 * was measured on.
 *
 * Wrapped in its own try/catch on purpose. The whole value of this endpoint is
 * that it answers when everything else is uncertain, so the diagnostic half must
 * never be able to take the version half down with it — a throw here degrades to
 * `models: null`, which is itself a legible answer ("resolution is broken"),
 * rather than a 500 that says nothing at all.
 *
 * `servedModelsSnapshot()` may be null when no request has warmed the catalogue.
 * That is reported rather than hidden: `catalogue.known === false` means the
 * roles below are the UNFILTERED first choice of each preference list, which is
 * what would run, but is not proof the gateway serves it. Distinguishing the two
 * is the point.
 */
function modelReport() {
  try {
    const available = servedModelsSnapshot()
    const report = describeRoleModels({ available })
    return {
      roles: report.roles.map(r => ({
        role: r.role,
        model: r.model,
        think: r.think,
        temperature: r.temperature ?? null,
        reasoning: r.reasoning,
        // The candidates ahead of the winner that the gateway is not serving.
        // An empty list here and a non-empty one there is the difference between
        // "configured for this" and "fell back to this".
        skipped: r.skipped
      })),
      // Named as warnings, not as an error: every one of these is a deployment
      // that works and answers, which is precisely why they need saying out loud.
      warnings: report.warnings,
      on_profile: report.warnings.length === 0
    }
  } catch {
    return null
  }
}

export async function GET() {
  return Response.json({
    name: APP_CLIENT_NAME,
    version: APP_VERSION,
    user_agent: APP_USER_AGENT,
    // '0.0.0' is the deliberate fallback in lib/appVersion.mjs — surface it as a
    // flag rather than leaving a caller to recognise the sentinel themselves.
    version_resolved: APP_VERSION !== '0.0.0',
    mcp_url: process.env.VFB_MCP_URL || DEFAULT_VFB_MCP_URL,
    node: process.version,
    models: modelReport(),
    // Age and health of the gateway catalogue the resolution above was filtered
    // against. `known: false` is not a failure — the catalogue is an
    // optimisation that fails open — but it does change how much the `models`
    // block is worth, so the two travel together.
    catalogue: (() => { try { return catalogueStatus() } catch { return null } })()
  }, {
    // A cached answer here is worse than no answer: the whole point is telling a
    // stale deployment from a fresh one, and an intermediary holding the previous
    // version would say precisely the wrong thing.
    headers: { 'cache-control': 'no-store' }
  })
}
