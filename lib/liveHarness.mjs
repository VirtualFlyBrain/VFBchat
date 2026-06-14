// Live wiring for the role-loop harness — the integration that turns the pure
// role libraries (orchestrator/controller/planner/ledger) into the request path
// the web interface serves. This is the ONLY orchestration path on this branch;
// the legacy in-route relay loop has been retired.
//
// Everything the harness needs from route.js (tool execution, graph/image
// extraction, ELM streaming) is INJECTED, so this module imports nothing from
// route.js (no circular import) and stays offline-testable with mocks.
//
// Responsibilities:
//   - build per-role deps for runHarness (models, callStructured, synth stream)
//   - vote the planner (self-consistency) — free under the ELM unpaid posture
//   - capture graph specs + thumbnail URLs from every tool result (richness)
//   - surface tool usage / rounds for governance
// See outputs/reports/vfbchat-harness-design.md §4, §8, §9.

import { runHarness } from './orchestrator.mjs'
import { callStructured, callStructuredVoted } from './elmClient.mjs'
import { resolveRoleModel } from './structuredOutput.mjs'
import { buildFollowOns, buildTermLinks, buildCountLinks } from './followOns.mjs'
import { buildTables, galleryThumbnails } from './resultTables.mjs'
import { parseThumbnailEntity } from './termInfoDigest.mjs'

// VFB thumbnail URL shape. Real URLs are http(s), www optional, with a SHARDED
// path of several segments, e.g.
//   http://www.virtualflybrain.org/data/VFB/i/jrmc/20bn/VFB_00101567/thumbnail.png
// The previous 2-segment https-only pattern matched none of them.
const THUMBNAIL_RE = /https?:\/\/(?:www\.)?virtualflybrain\.org\/data\/VFB\/i\/(?:[^/\s)]+\/)+thumbnail(?:T)?\.png/gi
// VFB thumbnails appear in tool output as markdown images "![alt](url 'title')";
// the alt text is the entity name (e.g. "SLP037_R aligned to JRC2018U"). Capture
// it so thumbnails get a real label instead of a generic "VFB image".
const THUMBNAIL_MD_RE = /!\[([^\]]*)\]\((https?:\/\/(?:www\.)?virtualflybrain\.org\/data\/VFB\/i\/(?:[^/\s)]+\/)+thumbnail(?:T)?\.png)[^)]*\)/gi

// Trim VFB's " aligned to <template>" suffix so the label is just the entity name.
function cleanThumbnailLabel(s = '') {
  return String(s).replace(/\s+aligned to\b.*$/i, '').trim()
}

/** Collect unique thumbnails as { url, label } from an arbitrary tool result. */
export function collectThumbnails(out, into = []) {
  let s
  try { s = typeof out === 'string' ? out : JSON.stringify(out) } catch { return into }
  if (!s) return into
  const seen = new Set(into.map(t => (typeof t === 'string' ? t : t && t.url)))
  let m
  // 1. markdown images with alt text -> { url, label, id }
  THUMBNAIL_MD_RE.lastIndex = 0
  while ((m = THUMBNAIL_MD_RE.exec(s)) !== null) {
    const url = m[2].replace(/^http:/i, 'https:')
    if (seen.has(url)) continue
    seen.add(url)
    into.push({ url, label: cleanThumbnailLabel(m[1]), id: parseThumbnailEntity(url).id })
  }
  // 2. any remaining bare URLs (no surrounding markdown) -> no label
  THUMBNAIL_RE.lastIndex = 0
  while ((m = THUMBNAIL_RE.exec(s)) !== null) {
    const url = m[0].replace(/^http:/i, 'https:')
    if (seen.has(url)) continue
    seen.add(url)
    into.push({ url, label: '', id: parseThumbnailEntity(url).id })
  }
  return into
}

/**
 * Build the deps object for runHarness plus a `collected` sink (graphs,
 * thumbnails, tool usage, rounds) the caller reads after the run.
 *
 * @param {object} p injected primitives
 * @param {string} p.apiBaseUrl
 * @param {string} p.apiKey
 * @param {object} [p.env]
 * @param {Array}  p.toolDefs           [{ name, purpose|description, parameters }]
 * @param {(name:string,args:object)=>Promise<any>} p.executeTool  raw tool exec
 * @param {(out:any)=>Array} p.collectGraphs   graph specs from one tool output
 * @param {(o:{messages,model})=>Promise<string>} p.streamText  synth (streams + returns full text)
 * @param {(s:{message,phase})=>void} [p.onStatus]
 * @param {Array} [p.history]
 * @param {number} [p.maxToolRounds]
 * @param {number} [p.plannerVotes=3]
 */
export function buildLiveDeps(p) {
  const env = p.env || process.env
  // The configured chat model is the per-role default unless VFB_MODEL_<ROLE> /
  // VFB_MODEL_DEFAULT override it — so wiring the harness doesn't silently change
  // which model serves requests.
  const fallback = p.defaultModel || undefined
  const models = {
    planner: resolveRoleModel('planner', env, fallback),
    extract: resolveRoleModel('extract', env, fallback),
    synth: resolveRoleModel('synth', env, fallback)
  }
  const collected = { graphs: [], thumbnails: [], expression: [], countEstimates: [], toolUsage: {}, toolRounds: 0 }

  const runTool = async (name, args) => {
    collected.toolUsage[name] = (collected.toolUsage[name] || 0) + 1
    collected.toolRounds += 1
    // A tool throwing must NOT crash the whole request (this is what made the
    // graph-form question hard-error). Degrade to a structured error the
    // extractor treats as "not answered", so the loop can broaden or abstain.
    let out
    try {
      out = await p.executeTool(name, args)
    } catch (err) {
      const msg = String(err?.message || err)
      collected.toolErrors = collected.toolErrors || []
      collected.toolErrors.push({ tool: name, error: msg })
      // Detailed failure report to stdout (container log).
      try {
        console.error(`[VFBchat] TOOL FAILED | tool=${name} | args=${JSON.stringify(args).slice(0, 400)} | error=${msg}`)
      } catch { /* logging best-effort */ }
      return { error: msg, tool: name }
    }
    try {
      const g = p.collectGraphs ? p.collectGraphs(out) : []
      if (Array.isArray(g) && g.length) collected.graphs.push(...g)
    } catch { /* graph extraction is best-effort */ }
    collectThumbnails(out, collected.thumbnails)
    // Collect a scRNA-seq expression matrix so the precise per-subtype numbers can
    // be rendered deterministically (the weak synthesiser tends to drop them).
    try {
      const parsed = typeof out === 'string' ? JSON.parse(out) : out
      if (parsed && parsed.tool === 'vfb_scrnaseq_gene_expression' && Array.isArray(parsed.genes) && parsed.genes.length) {
        collected.expression.push(parsed)
      }
      // Published neuron-count estimates (with PMIDs) to render with a citation.
      if (parsed && parsed.tool === 'vfb_get_region_neuron_count' && Array.isArray(parsed.count_candidates) && parsed.count_candidates.length) {
        collected.countEstimates.push(parsed)
      }
    } catch { /* not a structured payload */ }
    return out
  }

  // Planner is voted (self-consistency); other structured calls run once. Both
  // rely on ELM constrained decoding first, validate-and-retry as fallback.
  const plannerVotes = Math.max(1, p.plannerVotes ?? 3)
  const callStructuredDep = async (o) => {
    const base = {
      baseUrl: p.apiBaseUrl, apiKey: p.apiKey,
      model: o.model || models.extract,
      messages: o.messages, schema: o.schema, schemaName: o.schemaName,
      useGuidedJson: Boolean(o.useGuidedJson), temperature: 0
    }
    if (o.schemaName === 'plan' && plannerVotes > 1) {
      const v = await callStructuredVoted({ ...base, k: plannerVotes })
      return v.ok ? { ok: true, value: v.value } : { ok: false, error: v.error }
    }
    return callStructured(base)
  }

  const callTextStream = ({ messages, model }) =>
    p.streamText({ messages, model: model || models.synth })

  const deps = {
    toolDefs: p.toolDefs,
    models,
    maxToolRounds: p.maxToolRounds || 24,
    callStructured: callStructuredDep,
    callTextStream,
    callText: callTextStream,     // no separate non-streaming path; stream is the sink
    runTool,
    onStatus: p.onStatus,
    history: p.history,
    get imageHints() { return collected.thumbnails }
  }
  return { deps, collected, models }
}

/**
 * Run the harness for a question with live primitives. Returns the answer plus
 * the collected richness (graphs, thumbnails) and governance counters.
 */
export async function runLiveHarness(opts) {
  const { deps, collected } = buildLiveDeps(opts)
  const r = await runHarness(opts.question, deps)
  // Deterministic follow-on chips + provenance sources from the resolved terms.
  const followOns = buildFollowOns(r.ledger || {})
  return {
    answer: r.answer || '',
    clarify: Boolean(r.clarify),
    complete: Boolean(r.complete),
    ledger: r.ledger,
    trace: r.trace,
    graphs: collected.graphs,
    thumbnails: collected.thumbnails,
    expression: collected.expression,
    countEstimates: collected.countEstimates,
    toolUsage: collected.toolUsage,
    toolRounds: collected.toolRounds,
    followOns: followOns.chips,
    sources: followOns.sources,
    terms: followOns.terms,
    termLinks: buildTermLinks(r.ledger || {}),
    countLinks: buildCountLinks(r.ledger || {}),
    tables: buildTables(r.ledger || {}, opts.question || ''),
    galleryThumbnails: galleryThumbnails(r.ledger || {}, opts.question || '')
  }
}
