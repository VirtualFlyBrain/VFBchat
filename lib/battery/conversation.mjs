// Multi-turn battery support — pure logic only.
//
// A single question can be graded on its answer alone. A CONVERSATION cannot:
// the thing that goes wrong across a turn boundary is not usually the prose, it
// is the state — an id that was resolved and then forgotten, a chip that arrives
// without the address it was built from, a follow-on that offers back the
// question just answered. Those are all observable in the `result` event, and
// they are observable *deterministically*, so this module checks them with
// assertions rather than handing them to a judge that would have to infer intent
// from wording.
//
// The runner in scripts/run-task-battery.mjs owns the network; everything here
// is offline-testable.

/** Conversations live in their own tier so `--tier 7` runs exactly them. */
export const CONVERSATION_TIER = 7

/**
 * The claim the context feature exists to make impossible: that a term is
 * unmatched in a session that has already matched it. Kept deliberately broad —
 * this is checked only on turns whose expectation opts in, so a false positive
 * costs a failed assertion on a turn that was asserting precisely this.
 */
export const UNMATCHED_CLAIM_RE =
  /(not matched to a specific vfb (?:entity|term)|could not be matched|was not matched to|no matching vfb (?:term|entity))/i

function asArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function normalizeTurn(turn, taskId, index) {
  const where = `${taskId} turn ${index + 1}`
  if (!turn || typeof turn !== 'object') throw new Error(`${where}: each turn must be an object.`)

  const question = String(turn.question || '').trim()
  const rawClick = turn.click_followon ?? turn.clickFollowOn
  const click = rawClick === undefined || rawClick === null ? null : Number(rawClick)

  if (click !== null && (!Number.isInteger(click) || click < 0)) {
    throw new Error(`${where}: click_followon must be a non-negative integer.`)
  }
  if (!question && click === null) {
    throw new Error(`${where}: needs either "question" or "click_followon".`)
  }
  // A click is a click on something. Turn 1 has no previous answer and therefore
  // no chips, so a leading click is not a slow failure at run time — it is a
  // malformed task, and saying so at parse time costs no model calls.
  if (click !== null && index === 0) {
    throw new Error(`${where}: cannot click a follow-on before the first answer.`)
  }

  return { question, click_followon: click, expect: turn.expect || null }
}

/**
 * Canonicalise one battery task. A single-question task becomes a one-turn
 * conversation, so the runner has exactly one shape to execute and the recorded
 * output keeps its existing fields.
 */
export function normalizeBatteryTask(task, index = 0) {
  const id = String(task?.id || '').trim()
  const title = String(task?.title || '').trim()
  const rawTurns = Array.isArray(task?.turns) ? task.turns : null
  const question = String(task?.question || '').trim()
  const tier = Number.parseInt(task?.tier ?? id.match(/^[A-Z]*(\d+)/)?.[1] ?? '', 10)

  if (!id || !title || !Number.isFinite(tier)) {
    throw new Error(`Invalid task at index ${index}. Required fields: id, tier, title.`)
  }
  if (!rawTurns && !question) {
    throw new Error(`Invalid task ${id}. Needs either "question" or "turns".`)
  }
  if (rawTurns && rawTurns.length === 0) {
    throw new Error(`Invalid task ${id}. "turns" must not be empty.`)
  }

  const turns = (rawTurns || [{ question }]).map((turn, i) => normalizeTurn(turn, id, i))
  const requiresGraph = Boolean(task?.requires_graph || task?.requiresGraph)
  const minGraphs = Number.parseInt(task?.min_graphs ?? task?.minGraphs ?? 1, 10)

  return {
    id,
    tier,
    title,
    // The reported `question` is the one a reader recognises the task by, and for
    // a conversation that is how it opens.
    question: turns[0].question || question,
    turns,
    conversation: turns.length > 1,
    requires_graph: requiresGraph,
    min_graphs: requiresGraph ? Math.min(Math.max(Number.isFinite(minGraphs) ? minGraphs : 1, 1), 20) : 0
  }
}

/** The nth chip a user could actually click: `kind:"ask"`, in display order. */
export function selectAskChip(followOns, index) {
  const chips = (Array.isArray(followOns) ? followOns : []).filter(c => c && c.kind === 'ask')
  return chips[index] || null
}

/** The address a clicked chip posts back, or null if it has none to post. */
export function chipFocus(chip) {
  if (!chip || !chip.id || !chip.query_type) return null
  return { id: chip.id, query_type: chip.query_type }
}

function sameQuery(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase()
}

/**
 * Check one turn against its expectations, plus the invariants that hold for
 * every turn. Returns a list of human-readable problems; empty means clean.
 *
 * `observed` is what the turn produced: {answer, followOns, context, focus},
 * where `focus` is the address posted for this turn (a clicked chip) or null.
 */
export function checkTurn(expect, observed = {}) {
  const problems = []
  const answer = String(observed.answer || '')
  const chips = (Array.isArray(observed.followOns) ? observed.followOns : []).filter(c => c && c.kind === 'ask')
  const terms = Array.isArray(observed.context?.terms) ? observed.context.terms : []
  const focus = observed.focus || null

  // Invariant, not an expectation: a chip is a promise about a specific query on
  // a specific term. One that arrives without both halves of that address forces
  // the next turn to re-derive from English what the chip already knew, which is
  // the exact failure v4.0.1 was cut for.
  const addressless = chips.filter(c => !c.id || !c.query_type)
  if (addressless.length > 0) {
    problems.push(`${addressless.length} follow-on chip(s) carry no (id, query_type): ${addressless.map(c => c.query).join(' / ')}`)
  }

  if (!expect) return problems

  for (const wanted of asArray(expect.context_carries)) {
    const needle = String(wanted).toLowerCase()
    const hit = terms.some(t => String(t?.label || t?.name || '').toLowerCase().includes(needle))
    if (!hit) {
      problems.push(`context does not carry "${wanted}" (carries: ${terms.map(t => t?.label || t?.name).filter(Boolean).join(', ') || 'nothing'})`)
    }
  }

  for (const wantedId of asArray(expect.context_carries_id)) {
    if (!terms.some(t => t?.id === wantedId)) {
      problems.push(`context does not carry id ${wantedId} (carries: ${terms.map(t => t?.id).filter(Boolean).join(', ') || 'nothing'})`)
    }
  }

  if (expect.no_unmatched_claim) {
    const claim = answer.match(UNMATCHED_CLAIM_RE)
    if (claim) problems.push(`answer claims the term was not matched: "${claim[0]}"`)
  }

  if (Number.isFinite(Number(expect.min_followons)) && chips.length < Number(expect.min_followons)) {
    problems.push(`expected at least ${expect.min_followons} follow-on(s), got ${chips.length}`)
  }

  for (const word of asArray(expect.mentions)) {
    if (!new RegExp(`(?<!\\w)${String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'i').test(answer)) {
      problems.push(`answer never mentions "${word}"`)
    }
  }

  for (const word of asArray(expect.not_mentions)) {
    if (new RegExp(`(?<!\\w)${String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'i').test(answer)) {
      problems.push(`answer mentions "${word}", which this turn should not be about`)
    }
  }

  // The code handoff. Checked against the STRUCTURED payload, not the prose,
  // because the payload is what a client renders and what the user pastes; a
  // snippet that names the right function inside a sentence and the wrong id
  // inside the code block would pass a prose check and fail the user.
  const repro = observed.reproduction || null
  const wantsRepro = expect.reproduces_id || expect.reproduces_call || expect.python_block
  if (wantsRepro && !repro) {
    problems.push('no reproduction payload was returned for a turn that should have one')
  } else if (repro) {
    for (const wantedId of asArray(expect.reproduces_id)) {
      // The point of the feature: the snippet must carry the id THIS
      // conversation resolved, so re-running it cannot land on a homonym.
      if (!(repro.ids || []).some(t => t.id === wantedId) && !new RegExp(`'${wantedId}'`).test(String(repro.python || ''))) {
        problems.push(`reproduction does not carry id ${wantedId} (carries: ${(repro.ids || []).map(t => t.id).join(', ') || 'nothing'})`)
      }
    }
    for (const wantedFn of asArray(expect.reproduces_call)) {
      if (!(repro.calls || []).some(c => c.fn === wantedFn)) {
        problems.push(`reproduction does not call ${wantedFn} (calls: ${(repro.calls || []).map(c => c.fn).join(', ') || 'nothing'})`)
      }
    }
    // Never emit a line we cannot vouch for: every call in the payload must
    // appear in the snippet, and the snippet must not invent one.
    for (const c of (repro.calls || [])) {
      if (!String(repro.python || '').includes(c.python)) {
        problems.push(`reproduction lists ${c.python} but the snippet does not contain it`)
      }
    }
  }

  if (expect.python_block && !/```python\n[\s\S]*?```/.test(answer)) {
    problems.push('answer carries no python block for a turn that asked for the code')
  }
  if (expect.no_python_block && /```python/.test(answer)) {
    problems.push('answer carries an unrequested python block')
  }

  // Only meaningful on a clicked turn: with no focus there is no "the question
  // just answered" to compare against, and inventing one from the prose would be
  // guessing. Silence here is the honest reading, not a missing check.
  if (expect.no_repeat_of_focus && focus) {
    const repeat = chips.find(c => c.id === focus.id && sameQuery(c.query_type, focus.query_type))
    if (repeat) problems.push(`offers back the question just answered: "${repeat.query}"`)
  }

  return problems
}

/**
 * A follow-up turn that takes this long has already lost the user, whatever it
 * eventually says.
 *
 * The number is not arbitrary. Turn 1 of "what is the medulla?" is answered by
 * the deterministic fast path in about ten seconds, and the premise of the warm
 * routes is that a follow-up on a term already in hand is the SAME kind of work —
 * the id is known, the offered queries are known, so there is nothing left to
 * infer. A follow-up that instead spends minutes is one that fell through to the
 * planner and re-derived from English what the context already held, and because
 * the planner then votes, disagrees with itself and escalates, "minutes" means
 * 381s in the case that prompted this tier and 18 minutes in the worst one found.
 * Ninety seconds is deliberately loose: it leaves room for a genuinely cold
 * second topic to take the slow path honestly, and still fails every instance of
 * the defect. Note this is a FLAG, not an assertion — a slow turn is reported,
 * not failed, because latency is the one thing here that a busy gateway can make
 * look like a regression when nothing changed in the code.
 */
export const SLOW_FOLLOWUP_MS = 90000

/**
 * The conversation flag names, in report order. Exported so the runner's summary
 * cannot drift from what this module actually produces.
 */
export const CONVERSATION_QUALITY_FLAGS = [
  'addressless_followon',
  'context_lost_across_turn',
  'unmatched_claim_after_resolve',
  'repeats_answered_question',
  'slow_followup_turn'
]

/**
 * Conversation-specific flags, derived from a finished task record.
 *
 * These are kept apart from the answer-quality flags because they describe the
 * MACHINERY rather than the answer: a run can raise every one of them while each
 * individual turn reads perfectly, and that combination — fluent prose over lost
 * state — is precisely the one worth surfacing, because it is the one a human
 * skim-reading the transcript will pass as fine.
 *
 * The flags are read back off the problem strings checkTurn already produced
 * rather than recomputed from the raw turns. That is on purpose: it keeps one
 * definition of each failure, so a flag can never disagree with the assertion
 * that failed the task.
 */
export function classifyConversationQuality(result = {}) {
  const turns = Array.isArray(result.turns) ? result.turns : []
  const problems = Array.isArray(result.expectation_problems) ? result.expectation_problems : []
  const followUps = turns.slice(1)
  const any = (re) => problems.some(p => re.test(String(p)))

  return {
    addressless_followon: any(/carry no \(id, query_type\)/),
    context_lost_across_turn: any(/context does not carry/),
    unmatched_claim_after_resolve: any(/claims the term was not matched/),
    repeats_answered_question: any(/offers back the question just answered/),
    slow_followup_turn: followUps.some(t => Number(t?.duration_ms || 0) >= SLOW_FOLLOWUP_MS),
    // Reported, never thresholded: the worst follow-up is the number to watch
    // move between releases, and a mean over one fast turn and one 381s turn
    // reports "fine".
    slowest_followup_ms: followUps.reduce((worst, t) => Math.max(worst, Number(t?.duration_ms || 0)), 0)
  }
}
