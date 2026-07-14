// Constrained tool-call argument repair (pure logic).
//
// When the weak model emits a tool call missing required arguments (e.g.
// get_term_info {} or run_query {}), the current harness returns a text
// instruction the model often ignores, then gives up. Instead, when
// VFB_STRUCTURED_TOOLCALLS is enabled, the loop asks the model to fill the
// arguments under a constrained (guided_json) decode using the conversation
// evidence, then executes with the repaired arguments.
//
// Only the pure helpers live here (offline-testable); the network call and loop
// wiring are in app/api/chat/route.js. See the design report §9 (Finding 2).

function isEmptyArgValue(v) {
  return v === undefined || v === null ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
}

/**
 * Required argument names that are missing or empty on a tool call.
 * @param {{name:string, arguments?:object}} toolCall
 * @param {Map<string,object>|object} paramsByName  tool name → JSON schema params
 * @returns {string[]}
 */
export function getMissingRequiredArgs(toolCall, paramsByName) {
  const name = toolCall?.name
  const params = paramsByName instanceof Map ? paramsByName.get(name) : paramsByName?.[name]
  const required = params && Array.isArray(params.required) ? params.required : []
  const args = (toolCall && toolCall.arguments) || {}
  return required.filter(r => isEmptyArgValue(args[r]))
}

/**
 * Build messages asking the model to complete a tool call's arguments using the
 * gathered evidence. The caller constrains the output to the tool's parameter
 * schema via guided_json.
 */
export function buildRepairMessages({ toolCall, params, userQuestion = '', evidenceContext = '' }) {
  const system = `You are completing the arguments for a Virtual Fly Brain (VFB) tool call.
Using the user's question and the evidence already gathered, output ONLY a JSON object of valid, non-empty arguments for the tool "${toolCall?.name}".
For region / anatomy / neuron_type / focus arguments, use the natural-language term from the user's question (e.g. "antennal lobe") — the server resolves names to ids, so do NOT put an id there.
Use an FBbt/VFB id ONLY for an explicit id argument (e.g. "id"), and only when that exact id appears in the evidence; never invent ids.
Do not add commentary.`
  const user = `USER QUESTION:
${userQuestion}

TOOL: ${toolCall?.name}
PARAMETER SCHEMA:
${JSON.stringify(params)}

EVIDENCE GATHERED SO FAR (use ids/labels from here):
${evidenceContext || '(none yet)'}

CURRENT INCOMPLETE ARGUMENTS: ${JSON.stringify((toolCall && toolCall.arguments) || {})}

Return the complete arguments object as JSON.`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/** Merge repaired args over the original, keeping only non-empty repaired values. */
export function mergeRepairedArgs(original = {}, repaired = {}) {
  const out = { ...(original || {}) }
  for (const [k, v] of Object.entries(repaired || {})) {
    if (!isEmptyArgValue(v)) out[k] = v
  }
  return out
}

export { isEmptyArgValue }
