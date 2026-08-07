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

const VFB_ID_RE = /^(?:FBbt|FBgn|FBal|FBti|FBtp|FBco|FBlc|FBrf|VFBexp|VFB)_[0-9a-zA-Z]+$/

/**
 * Fill a missing `id` from the terms this request has already resolved.
 *
 * This runs BEFORE buildRepairMessages, and the ordering is the whole point. The
 * repair call asks a model to infer arguments from the question and the evidence
 * gathered so far — which works well when the question names its subject, and
 * not at all on the turn this exists for:
 *
 *   turn 2  "And which neurons have part of their arbour there?"
 *
 * The question names nothing, and on a turn whose steps have not run yet the
 * evidence context is empty, so the model is being asked to produce an id out of
 * two blanks. It cannot, the step dispatches with no id, and the resulting
 * failure is reported to the user as a fact about VFB. Meanwhile the id is
 * sitting in the ledger, put there by the term resolution that has ALREADY
 * happened this turn — the controller resolves terms before it runs steps.
 *
 * So: look it up rather than infer it. Nothing is guessed here that could be
 * known, which is the general shape of every fix in this file's neighbourhood.
 *
 * Two deliberate restrictions:
 *
 *   - only an argument named exactly `id`. Other id-shaped parameters
 *     (`dataset_id`, `template_id`) name a different KIND of thing, and an
 *     anatomy term filled into one of them would produce a call that runs,
 *     returns nothing, and reads as data absence — the failure this is fixing,
 *     one layer down. A narrow rule that helps the observed case is worth more
 *     than a general one that invents new ways to be confidently wrong.
 *   - only the FIRST resolved term. `terms` arrives in resolution order, and on
 *     a subjectless turn the first is the antecedent the orchestrator adopted
 *     from the conversation, which is precisely the entity the question is
 *     about. Ranking further than that would be a preference between subjects,
 *     and this function has no evidence to form one with.
 *
 * @param {object} args      the tool call's arguments so far
 * @param {string[]} missing required argument names that are missing or empty
 * @param {Array<{id?:string}>} terms  resolved terms, in resolution order
 * @returns {{args: object, filled: string[]}}
 */
export function backfillIdArgs(args = {}, missing = [], terms = []) {
  if (!Array.isArray(missing) || !missing.includes('id')) return { args, filled: [] }
  const term = (Array.isArray(terms) ? terms : []).find(t => typeof t?.id === 'string' && VFB_ID_RE.test(t.id))
  if (!term) return { args, filled: [] }
  return { args: { ...args, id: term.id }, filled: ['id'] }
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
