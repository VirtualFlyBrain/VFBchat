// What this service can truthfully say about itself.
//
// Users ask "what version are you?" and "which model is this?", and until now
// the honest answer was that the assistant had no idea: the version lives in
// lib/appVersion.mjs, the resolved models live in roleProfiles/modelCatalogue,
// and none of it was ever in front of the model. So it either declined or —
// worse — guessed from whatever it remembered about itself from pre-training,
// which for a question about OUR deployment is fabrication with a confident
// tone.
//
// Deliberately built from the SAME functions /api/version uses, rather than by
// calling that endpoint over HTTP. Three reasons: a server calling its own
// public URL is a pointless round trip; it would need a new outbound host on the
// allow-list; and a tool the model may or may not choose to call turns a fact
// into a maybe. Everything here is already in process.
//
// This is a narrow, deliberate exception to the rule that the model is given no
// facts — see 13-model-card.md. The exception is safe because these facts are
// not about Drosophila: they cannot contaminate an answer about the data, and
// the alternative is a confident guess about our own deployment. Nothing here is
// secret. The version and the model ids are already served, unauthenticated, at
// /api/version, and the model ids are in every /v1/models response the ELM
// gateway returns.

import { APP_VERSION, APP_CLIENT_NAME } from './appVersion.mjs'
import { describeRoleModels } from './roleProfiles.mjs'
import { servedModelsSnapshot } from './modelCatalogue.mjs'

const DEFAULT_VFB_MCP_URL = 'https://vfb3-mcp-preview.virtualflybrain.org/'

/**
 * A compact block of service facts for the end of the system prompt.
 *
 * Kept to a handful of lines on purpose. Anything longer competes for attention
 * with the grounding rules, which are the part of this prompt that matters.
 *
 * Note on numbers: the grounding audit flags unbacked numbers of four or more
 * digits (LARGE_NUMBER_RE in lib/grounding.mjs). "4.2.4" and
 * "Qwen/Qwen3.5-397B-A17B-FP8" contain no four-digit run, so neither trips it
 * and no exemption is needed. A future model id with a long numeric run — a
 * context size, say — would, so keep that in mind when the catalogue changes.
 */
export function serviceIdentityBlock(overrides = {}) {
  const version = overrides.version || APP_VERSION
  const mcpUrl = overrides.mcpUrl || process.env.VFB_MCP_URL || DEFAULT_VFB_MCP_URL

  let roleLine = 'model resolution unavailable'
  try {
    const report = overrides.report || describeRoleModels({ available: servedModelsSnapshot() })
    const roles = Array.isArray(report?.roles) ? report.roles : []
    const distinct = [...new Set(roles.map(r => r.model).filter(Boolean))]
    if (distinct.length === 1) {
      roleLine = `${distinct[0]} for every role`
    } else if (distinct.length > 1) {
      roleLine = roles.map(r => `${r.role}: ${r.model}`).join('; ')
    }
  } catch {
    // A broken snapshot must not take the prompt down with it. "unavailable" is
    // a legible answer; a 500 on the chat route is not.
  }

  return `

ABOUT THIS SERVICE — factual, and the only self-description you may give:
- You are VFBchat (client id ${APP_CLIENT_NAME}), version ${version}.
- Language model: ${roleLine}, hosted on ELM, the University of Edinburgh's own AI platform. ELM runs these models on University infrastructure; your question is not sent to a commercial AI provider.
- Data comes from Virtual Fly Brain via its MCP server at ${mcpUrl}, not from your own memory.
- Answer from these facts if the user asks what you are, what version you are, or which model or platform you run on. Do not guess or elaborate beyond them, and do not mention them otherwise — they are not relevant to a question about neuroanatomy.
- If asked what data is kept about the conversation, do not improvise: point the user to the privacy notice at /privacy.`
}
