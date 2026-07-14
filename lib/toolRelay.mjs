// Schema-constrained tool relay.
//
// ELM's vLLM has native tool-calling disabled (probe: HTTP 400, needs
// --enable-auto-tool-choice / --tool-call-parser). So we keep emitting tool
// calls in-band as JSON — but generate that JSON under a strict json_schema and
// validate it, instead of regex-repairing free text. This gives guaranteed-valid
// tool calls without depending on EDINA enabling native tool calling.
//
// See outputs/reports/vfbchat-harness-design.md §9 (Finding 2) and ADR 0001.

import { extractFirstJson, validateAgainstSchema } from './structuredOutput.mjs'

/**
 * Build a strict json_schema for a tool-call envelope: { tool_calls: [ ... ] }.
 * Each call must name a known tool and carry an arguments object matching that
 * tool's parameter schema (expressed via oneOf over the tools).
 *
 * @param {Array<{name:string, parameters?:object}>} tools
 * @param {object} [opts]
 * @param {number} [opts.maxCalls]  cap on calls per turn (advisory; not enforced by schema)
 * @returns {object} JSON schema
 */
export function buildToolCallSchema(tools, opts = {}) {
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('tools required')
  const options = tools.map(t => ({
    type: 'object',
    additionalProperties: false,
    required: ['name', 'arguments'],
    properties: {
      name: { type: 'string', enum: [t.name] },
      arguments: t.parameters && typeof t.parameters === 'object'
        ? t.parameters
        : { type: 'object' }
    }
  }))
  const items = options.length === 1 ? options[0] : { oneOf: options }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['tool_calls'],
    properties: {
      tool_calls: { type: 'array', items }
    }
  }
}

/**
 * Parse and validate a model reply into tool calls.
 * Accepts either a raw string reply or an already-parsed value.
 *
 * @param {string|object} reply
 * @param {Array<{name:string, parameters?:object}>} tools
 * @returns {{ok:boolean, toolCalls:Array<{name:string,arguments:object}>, errors:string[]}}
 */
export function parseToolCalls(reply, tools) {
  const errors = []
  const toolByName = new Map((tools || []).map(t => [t.name, t]))

  const value = typeof reply === 'string' ? extractFirstJson(reply) : reply
  if (value === undefined || value === null) {
    return { ok: false, toolCalls: [], errors: ['no JSON found in reply'] }
  }

  // Accept both the envelope {tool_calls:[...]} and a bare array.
  const calls = Array.isArray(value) ? value
    : Array.isArray(value.tool_calls) ? value.tool_calls
    : null
  if (!calls) return { ok: false, toolCalls: [], errors: ['no tool_calls array'] }

  const out = []
  calls.forEach((call, i) => {
    if (!call || typeof call !== 'object') { errors.push(`call[${i}]: not an object`); return }
    const { name } = call
    const args = call.arguments ?? {}
    const tool = toolByName.get(name)
    if (!tool) { errors.push(`call[${i}]: unknown tool "${name}"`); return }
    if (args && typeof args !== 'object') { errors.push(`call[${i}]: arguments not an object`); return }
    if (tool.parameters) {
      const { valid, errors: argErrors } = validateAgainstSchema(args, tool.parameters, `call[${i}].arguments`)
      if (!valid) { errors.push(...argErrors); return }
    }
    out.push({ name, arguments: args })
  })

  return { ok: errors.length === 0 && out.length > 0, toolCalls: out, errors }
}
