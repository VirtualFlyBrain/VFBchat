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
import { safeToolArgs } from './safeToolArgs.mjs'
import { throwIfAborted, isRunAbortedWith } from './runSignal.mjs'

// The largest MCP result this process will turn into a JavaScript object graph.
// There was no size limit anywhere: mcpCallOptions sets only timeouts, and a
// broad query can return hundreds of thousands of rows.
export const MAX_TOOL_RESULT_CHARS = (() => {
  const raw = Number(process.env.VFB_MAX_TOOL_RESULT_CHARS)
  return Number.isFinite(raw) && raw >= 100000 ? raw : 4000000
})()
import { callStructured, callStructuredVoted, MIN_RETRY_MS } from './elmClient.mjs'
import { resolveRoleModel, majorityVote } from './structuredOutput.mjs'
import { roleForSchemaName, roleRequestOptions, PLANNER_ESCALATION } from './roleProfiles.mjs'
import { planVoteKey, votePlanWithEscalation } from './planner.mjs'
import { buildFollowOns, buildTermLinks, buildCountLinks } from './followOns.mjs'
import { buildReproduction, withReproduction } from './reproduce.mjs'
import { supersededCounts } from './countProvenance.mjs'
import { buildTables, galleryThumbnails } from './resultTables.mjs'
import { parseThumbnailEntity } from './termInfoDigest.mjs'
import { buildTurnContext, mergeContext } from './conversationContext.mjs'

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

// Eight thumbnails reach the user. An image-listing query can return 226k rows,
// each with a URL, so without a ceiling the collector built a 226k-element array
// of objects to render eight of them — and rebuilt a Set over the whole array on
// every subsequent tool call to dedupe, which is O(rounds x thumbnails).
export const MAX_COLLECTED_THUMBNAILS = 64

/**
 * Collect unique thumbnails as { url, label } from an arbitrary tool result.
 *
 * `seen` is the caller's dedupe set, kept across calls. It used to be rebuilt
 * from `into` at the top of every call.
 */
export function collectThumbnails(out, into = [], seen = new Set(into.map(t => (typeof t === 'string' ? t : t && t.url)))) {
  if (into.length >= MAX_COLLECTED_THUMBNAILS) return into
  let s
  try { s = typeof out === 'string' ? out : JSON.stringify(out) } catch { return into }
  if (!s) return into
  let m
  // 1. markdown images with alt text -> { url, label, id }
  THUMBNAIL_MD_RE.lastIndex = 0
  while ((m = THUMBNAIL_MD_RE.exec(s)) !== null) {
    const url = m[2].replace(/^http:/i, 'https:')
    if (seen.has(url)) continue
    seen.add(url)
    into.push({ url, label: cleanThumbnailLabel(m[1]), id: parseThumbnailEntity(url).id })
    if (into.length >= MAX_COLLECTED_THUMBNAILS) return into
  }
  // 2. any remaining bare URLs (no surrounding markdown) -> no label
  THUMBNAIL_RE.lastIndex = 0
  while ((m = THUMBNAIL_RE.exec(s)) !== null) {
    const url = m[0].replace(/^http:/i, 'https:')
    if (seen.has(url)) continue
    seen.add(url)
    into.push({ url, label: '', id: parseThumbnailEntity(url).id })
    if (into.length >= MAX_COLLECTED_THUMBNAILS) return into
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
    // v4.0.0: sufficiency and args are first-class roles rather than aliases of
    // planner/extract, so their model, sampling and reasoning mode can be set
    // independently. Defaulting through resolveRoleModel means an operator who
    // sets nothing still gets one consistent model everywhere.
    sufficiency: resolveRoleModel('sufficiency', env, fallback),
    extract: resolveRoleModel('extract', env, fallback),
    args: resolveRoleModel('args', env, fallback),
    synth: resolveRoleModel('synth', env, fallback)
  }
  const collected = {
    graphs: [], thumbnails: [], expression: [], countEstimates: [], toolUsage: {}, toolRounds: 0,
    // Kept across tool calls rather than rebuilt from `thumbnails` each time.
    thumbnailUrls: new Set(),
    // Planner self-consistency telemetry. v3.x computed `agreement` and dropped
    // it on the floor; it is the one complexity signal we get for free and
    // AFTER seeing the question, so it is now surfaced all the way out.
    plannerAgreement: null, plannerVotesUsed: 0, plannerEscalated: false, plannerRounds: []
  }

  const runTool = async (name, args) => {
    // Nobody is waiting: do not start another MCP round.
    throwIfAborted(p.signal, `tool:${name}`)
    collected.toolUsage[name] = (collected.toolUsage[name] || 0) + 1
    collected.toolRounds += 1
    // A tool throwing must NOT crash the whole request (this is what made the
    // graph-form question hard-error). Degrade to a structured error the
    // extractor treats as "not answered", so the loop can broaden or abstain.
    let out
    try {
      out = await p.executeTool(name, args)
    } catch (err) {
      // An abandoned run is not a tool failure. Degrading it to one would let
      // the loop carry on broadening against a client that has gone.
      //
      // But a tool that TIMED OUT is exactly a tool failure, and used to be
      // rethrown here because the predicate counted any AbortError as the run
      // being abandoned. It now takes the signal: only stop when this run really
      // was stopped. A timed-out tool degrades to a structured error, which is
      // what the loop already knows how to broaden or abstain around.
      if (isRunAbortedWith(err, p.signal)) throw err
      const msg = String(err?.message || err)
      collected.toolErrors = collected.toolErrors || []
      collected.toolErrors.push({ tool: name, error: msg })
      // Detailed failure report to stdout (container log). The ARGS are rendered
      // shape-only: search_reviewed_docs is called with the whole user question as
      // its `query` on every turn, so JSON.stringify(args) here put the question
      // verbatim into the cluster log on any doc-search blip.
      try {
        console.error(`[VFBchat] TOOL FAILED | tool=${name} | args=${safeToolArgs(args)} | error=${msg}`)
      } catch { /* logging best-effort */ }
      return { error: msg, tool: name }
    }
    // ONE parse. This result used to be materialised five times over, with every
    // copy alive at the same instant: joined into a string, JSON.parsed by the
    // graph collector, regex-scanned twice for thumbnails, JSON.parsed again
    // purely to test one key, and JSON.parsed a third time by the orchestrator.
    // At ~20 MB of JSON — a ListAllAvailableImages on the medulla is 226k rows —
    // that is three independent V8 object graphs at 5-10x the text size, live
    // together, for ONE tool call out of 24. It is not a leak; it is 5x
    // amplification of an uncapped payload, and it is the shape of 88 MB -> 6.8 GB.
    const text = typeof out === 'string' ? out : null
    let parsed = text === null ? out : null
    if (text !== null) {
      if (text.length > MAX_TOOL_RESULT_CHARS) {
        // Above the cap, do not build an object graph at all. Nothing that large
        // is a graph, an expression matrix or a count payload, and the extractor
        // reads a bounded slice of the text regardless.
        console.error(`[VFBchat] TOOL RESULT OVER CAP | tool=${name} | chars=${text.length} | cap=${MAX_TOOL_RESULT_CHARS} — not parsed`)
      } else {
        try { parsed = JSON.parse(text) } catch { parsed = null }
      }
    }

    try {
      const g = p.collectGraphs ? p.collectGraphs(out, parsed) : []
      if (Array.isArray(g) && g.length) collected.graphs.push(...g)
    } catch { /* graph extraction is best-effort */ }
    collectThumbnails(parsed ?? out, collected.thumbnails, collected.thumbnailUrls)
    // A scRNA-seq expression matrix, and published neuron-count estimates with
    // their PMIDs, so the precise numbers can be rendered deterministically —
    // the weak synthesiser tends to drop them.
    if (parsed && typeof parsed === 'object') {
      if (parsed.tool === 'vfb_scrnaseq_gene_expression' && Array.isArray(parsed.genes) && parsed.genes.length) {
        collected.expression.push(parsed)
      }
      if (parsed.tool === 'vfb_get_region_neuron_count' && Array.isArray(parsed.count_candidates) && parsed.count_candidates.length) {
        collected.countEstimates.push(parsed)
      }
    }
    // Hand the orchestrator the object when we have one: parseMaybe accepts it,
    // and that is the fourth parse gone.
    return parsed ?? out
  }

  // Every structured call is now shaped by its ROLE rather than by one global
  // `temperature: 0`. The orchestrator names its calls by schema, so the schema
  // name is the join: plan → planner, sufficiency → sufficiency, extract →
  // extract, <tool>_args → args. See lib/roleProfiles.mjs for the table and the
  // measurements behind it.
  const plannerVotes = Math.max(1, p.plannerVotes ?? 3)

  // The served-model catalogue is captured ONCE, here, and reused for every
  // role in this request. Reading it per role would let a refresh landing
  // mid-question put the planner on one model and the extractor on another —
  // a class of bug that reproduces roughly never and is unfalsifiable from the
  // logs when it does. Injected by the caller so this stays testable offline;
  // undefined means "unknown", which does no filtering.
  const servedModels = p.servedModels
  const optionsFor = (role, model) => roleRequestOptions(role, {
    env, fallback, model: model || models[role], available: servedModels
  })

  /**
   * Voted planner with RETROSPECTIVE escalation.
   *
   * The old code voted k identical greedy generations, which is not a vote. Now
   * the planner samples at its profile temperature, votes on the DECISION
   * (intent + tool sequence, see planVoteKey), and — when the samples disagree —
   * buys a second round and re-decides over the combined pool.
   *
   * The policy itself lives in planner.mjs (`votePlanWithEscalation`) so it can
   * be unit-tested without a network; this function is only the wiring that
   * turns it into ELM calls and governance counters.
   */
  const runVotedPlanner = async (base) => {
    if (plannerVotes <= 1) {
      const r = await callStructured(base)
      if (r.ok) {
        collected.plannerAgreement = 1
        collected.plannerVotesUsed = 1
        collected.plannerRounds.push({ agreement: 1, votes: 1, escalated: false })
      }
      return r
    }

    let lastError = null
    const outcome = await votePlanWithEscalation({
      votes: plannerVotes,
      policy: PLANNER_ESCALATION,
      voteKeyFn: planVoteKey,
      vote: majorityVote,
      // `budgetMs` is what the phase has LEFT, not what a round is worth: the
      // escalation round must finish inside the phase budget, not merely start
      // inside it. Each of the k votes runs in parallel, so the round's wall
      // clock is one vote's budget, not k of them.
      sample: async (k, budgetMs) => {
        const r = await callStructuredVoted({
          ...base, k, voteKeyFn: planVoteKey,
          ...(Number.isFinite(budgetMs) ? { budgetMs: Math.max(MIN_RETRY_MS, Math.min(base.budgetMs ?? budgetMs, budgetMs)) } : {})
        })
        if (!r.ok) { lastError = r.error; return [] }
        return r.results.filter(x => x.ok).map(x => x.value)
      },
      onContested: () => {
        if (typeof p.onStatus === 'function') {
          p.onStatus({ phase: 'plan', message: 'The plan is contested — sampling again before committing.' })
        }
      }
    })

    if (!outcome.ok) return { ok: false, error: lastError || outcome.error }

    collected.plannerAgreement = outcome.agreement
    collected.plannerVotesUsed = outcome.votes
    collected.plannerEscalated = collected.plannerEscalated || outcome.escalated
    // Recorded so a deployment that is quietly out of clock is legible in the
    // governance counters, rather than showing up only as worse agreement.
    collected.plannerBudgetExhausted = collected.plannerBudgetExhausted || Boolean(outcome.budgetExhausted)
    for (const round of outcome.rounds) collected.plannerRounds.push(round)
    return { ok: true, value: outcome.value }
  }

  const callStructuredDep = async (o) => {
    const role = roleForSchemaName(o.schemaName)
    const opts = optionsFor(role, o.model)
    const base = {
      baseUrl: p.apiBaseUrl, apiKey: p.apiKey,
      model: opts.model,
      signal: p.signal,
      messages: o.messages, schema: o.schema, schemaName: o.schemaName,
      // `guided_json` is accepted-then-IGNORED by the Qwen deployment (it is
      // enforced on Llama). The arg-repair path is the only caller, and it is
      // fully backstopped by validateAgainstSchema + retry in callStructured,
      // so the degradation is "one more attempt", never "silently wrong".
      useGuidedJson: Boolean(o.useGuidedJson),
      temperature: opts.temperature,
      timeoutMs: opts.timeoutMs,
      budgetMs: opts.budgetMs,
      extraBody: opts.extraBody
    }
    if (role === 'planner') return runVotedPlanner(base)
    return callStructured(base)
  }

  // Synthesis streams straight from route.js rather than through elmClient, so
  // its sampling has to travel with the request. Without this the Qwen swap
  // ships the default (thinking ON) into the user-visible path: 34-73s of blank
  // pane before the first token, for prose that measured no better.
  const callTextStream = ({ messages, model, sourceQuotes }) => {
    const opts = optionsFor('synth', model)
    return p.streamText({
      messages,
      model: opts.model,
      sourceQuotes,
      sampling: opts.sampling
    })
  }

  const deps = {
    toolDefs: p.toolDefs,
    models,
    maxToolRounds: p.maxToolRounds || 24,
    callStructured: callStructuredDep,
    callTextStream,
    callText: callTextStream,     // no separate non-streaming path; stream is the sink
    runTool,
    onStatus: p.onStatus,
    // Fired when a streamed draft is abandoned for a rewrite, so the client can
    // clear it before the replacement streams in. See discardDraft in
    // lib/orchestrator.mjs for why the client is the only place this can happen.
    onDraftDiscarded: p.onDraftDiscarded,
    history: p.history,
    // What earlier turns established (ids, labels, query catalogues) and, when
    // the user CLICKED a follow-on rather than typing, the exact {id, query_type}
    // that chip was generated from. Both arrive from the client and are
    // validated inside the harness — see lib/conversationContext.mjs.
    context: p.context,
    focus: p.focus,
    signal: p.signal,
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
  // The working behind the answer: the exact ids this turn resolved and the
  // exact catalogue queries it ran, as a runnable VFBquery snippet. Always
  // computed (a UI can offer it as a button on any turn); only APPENDED to the
  // prose when the user asked for code or ids, since an unrequested fenced
  // block is noise in a chat window.
  //
  // The carried context comes in too. A turn that asks "how would I get that same
  // result in Python?" runs no query of its own, so without it the snippet would
  // name the right term and no way to ask anything about it.
  const reproduction = buildReproduction(r.ledger || {}, {
    question: opts.question || '',
    context: opts.context || null
  })
  return {
    // withReproduction, not concatenation: where the model wrote its own VFB
    // snippet, ours replaces it rather than trailing after it.
    answer: withReproduction(r.answer || '', reproduction, opts.question || ''),
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
    // Planner self-consistency, surfaced for governance and for the battery:
    // a low agreement that was NOT escalated is a bug; a low agreement that was
    // is the system noticing a hard question and paying for it.
    plannerAgreement: collected.plannerAgreement,
    plannerVotesUsed: collected.plannerVotesUsed,
    plannerEscalated: collected.plannerEscalated,
    plannerRounds: collected.plannerRounds,
    followOns: followOns.chips,
    sources: followOns.sources,
    terms: followOns.terms,
    termLinks: buildTermLinks(r.ledger || {}),
    // {python, ids, calls, unmapped} or null. Structured so the client can
    // render a "reproduce in Python" affordance without parsing the prose.
    reproduction,
    countLinks: buildCountLinks(r.ledger || {}),
    // Figures a run disproved. buildCountLinks already reads the corrected
    // number, so these exist only for the prose backstop: a stale figure the
    // model was shown before the query ran and quoted anyway.
    supersededCounts: supersededCounts(r.ledger || {}),
    tables: buildTables(r.ledger || {}, opts.question || ''),
    galleryThumbnails: galleryThumbnails(r.ledger || {}, opts.question || ''),
    // The conversation's resolved info, this turn's folded into the prior turns'.
    // The server holds no session, so this goes back to the client with the
    // answer and the client posts it again on the next turn. That keeps the
    // request path stateless while giving the next turn the ids this one
    // established — which is the whole point: turn 2 should never have to
    // re-guess a term turn 1 already pinned down.
    context: mergeContext(opts.context, buildTurnContext(r.ledger || {}))
  }
}
