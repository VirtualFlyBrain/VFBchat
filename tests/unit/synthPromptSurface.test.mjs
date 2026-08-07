// What the synthesiser is told, and — more importantly — what it is NOT told.
//
// Every quality regression in this system's recent history has the same shape: a
// sentence added to fix one question shape is read by every other question shape
// and changes answers nobody was looking at. A licence to "name the remainder as
// a gap in VFB's documentation" became a closing tic on four unrelated questions
// and made the MCP answer drop its configuration block. The block-reproduction
// rule, said unconditionally, fenced a support email address.
//
// That class of defect was only ever caught by running the task battery and
// reading the prose — an expensive, nondeterministic signal (the planner and the
// doc extractor both vary run to run, so a bleed can hide for three runs). This
// file makes the same property cheap and deterministic: it pins WHICH prompt
// blocks reach the synthesiser for WHICH question and ledger shape.
//
// The test is deliberately written as a negative matrix. Asserting that the
// documentation block appears for a documentation question is nice; asserting it
// is ABSENT from a plain anatomy question is the assertion that would have caught
// every one of the regressions above. When a block legitimately needs to widen,
// this file is where that decision gets made explicitly rather than by accident.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runHarness } from '../../lib/orchestrator.mjs'

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'vfb_find_genetic_tools', purpose: 'find genetic tools', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
]

// A distinctive fragment of each conditional block, short enough to be stable
// across wording tweaks but unique enough that a match is unambiguous.
const BLOCKS = {
  available: /AVAILABLE VFB DATA/,
  unmatched: /UNMATCHED NAMES/,
  docAnswered: /DOCUMENTATION ANSWERED THIS/,
  docMiss: /NO PAGE ANSWERED THIS/,
  copyable: /Reproduce it in a fenced code block/,
  guidance: /WRITING GUIDANCE/,
  askWhichMeant: /ask which was meant/,
  docGapWording: /documentation does not appear to cover/,
  codeSupplied: /CODE IS ALREADY SUPPLIED FOR THIS ANSWER/
}

/** The last synthesis call's full message pair, for tests that need the system half. */
let lastSynthMessages = null

/**
 * Run the harness with mocked I/O and return the synthesiser's user message.
 *
 * The knobs are the four ledger facts the conditional blocks actually key on:
 * whether a term resolved, whether a planned step produced evidence, whether a
 * documentation page answered, and whether that page carried a copyable block.
 *
 * Two things about `plan` that cost an afternoon to discover, so they are
 * written down here rather than rediscovered:
 *
 *  1. detectFastPath() runs BEFORE the planner and, when it fires, the planner
 *     is never called and this `plan` is ignored entirely. "What is X?" is a
 *     fast-path shape, so those questions always run a vfb_get_term_info step
 *     whatever `plan.steps` says. Use a question the fast path does not claim
 *     when the step's tool matters.
 *  2. `steps: []` does not give a ledger with no steps. Term resolution and the
 *     deterministic injectors put steps back, and a term-info step always has a
 *     Queries array for summariseMacroToolRows to turn into evidence — so an
 *     empty plan produces a WELL-FED ledger, the opposite of the intuition.
 */
async function synthPrompt(question, {
  plan,
  resolves = true,
  candidates = [],
  stepEvidence = true,
  docAnswers = false,
  docPage = 'Point your client at mcp.virtualflybrain.org.',
  digestQueries = [{ label: 'NeuronsPartHere', count: 12 }]
} = {}) {
  const searchDocs = resolves
    ? [{ short_form: 'FBbt_00003932', label: question, original_label: question, facets_annotation: ['Entity', 'Class', 'Anatomy'] }]
    : candidates.map((c, i) => ({ short_form: `FBbt_0010000${i}`, label: c, original_label: c, facets_annotation: ['Entity', 'Class', 'Anatomy'] }))
  let messages = null
  const deps = {
    toolDefs: TOOL_DEFS,
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 8,
    async callStructured({ schemaName }) {
      if (schemaName === 'plan') return { ok: true, value: plan }
      if (schemaName === 'extract') {
        return { ok: true, value: stepEvidence
          ? { relevant: true, answered: true, claim: 'the extracted claim', verbatim: 'quoted source text' }
          : { relevant: false, answered: false, claim: '', verbatim: '' } }
      }
      if (schemaName && schemaName.endsWith('_args')) return { ok: true, value: { query: 'x', id: 'FBbt_00003932' } }
      return { ok: false }
    },
    async callText({ messages: m }) { messages = m; return 'ANSWER' },
    async runTool(name) {
      if (name === 'vfb_search_terms') return { response: { docs: searchDocs } }
      if (name === 'vfb_get_term_info') {
        // An unresolvable name has no term-info. Saying so matters: the fast
        // path plans a term-info step regardless, the arg repairer will happily
        // invent an id for it, and a mock that answered anyway would hand the
        // "nothing matched" tests a full evidence row and quietly invert them.
        if (!resolves) return { error: 'no such term' }
        return { Id: 'FBbt_00003932', Name: 'test term', Meta: { Description: 'a description' }, Publications: [],
          Queries: digestQueries.map(q => ({ label: q.label, count: q.count, query: q.label })) }
      }
      // A step whose tool ran and found nothing nameable — an empty named array
      // gives summariseMacroToolRows nothing to summarise. This is how a step
      // can run and leave the ledger genuinely thin.
      if (name === 'vfb_find_genetic_tools') return { results: [] }
      if (name === 'search_reviewed_docs') {
        return docAnswers ? { results: [{ id: 'p', title: 'A VFB page', url: 'https://www.virtualflybrain.org/docs/p' }] } : { results: [] }
      }
      if (name === 'get_reviewed_page') return docPage
      return { ok: true, result: `${name} result` }
    },
    searchReviewedDocs: async () => (docAnswers ? [{ id: 'p', title: 'A VFB page', url: 'https://www.virtualflybrain.org/docs/p' }] : []),
    getReviewedPage: async () => docPage
  }
  await runHarness(question, deps)
  assert.ok(messages, `synthesis did not run for "${question}"`)
  lastSynthMessages = messages
  return messages[1].content
}

/** Assert exactly the named blocks are present and every other block is absent. */
function assertBlocks(prompt, expected, label) {
  for (const [name, re] of Object.entries(BLOCKS)) {
    const want = expected.includes(name)
    const got = re.test(prompt)
    assert.equal(got, want, `${label}: expected ${name} to be ${want ? 'PRESENT' : 'ABSENT'}`)
  }
}

const ANATOMY_PLAN = {
  intent: 'term_info', underspecified: false, clarifying_question: '',
  terms_to_resolve: ['mushroom body'],
  steps: [{ id: 's1', tool: 'vfb_get_term_info', answers: ['what is the mushroom body'] }]
}

test('a plain anatomy question that resolved and answered gets no conditional block at all', async () => {
  // The baseline that matters. Every rule written for a documentation question,
  // an unmatched name or a thin ledger must be invisible here — this is the
  // question shape that silently pays for guidance aimed at other shapes.
  const prompt = await synthPrompt('What is the mushroom body?', { plan: ANATOMY_PLAN })
  assertBlocks(prompt, [], 'plain anatomy')
})

test('the always-on closing rule is always on, and is the last thing read', async () => {
  // Recency beats the system prompt in this stack: the anti-meta-commentary ban
  // lives in the system message and stopped holding once the doc block grew, so
  // it was moved to the end of the user message. If something is ever appended
  // after it, that something wins and this fails.
  const prompt = await synthPrompt('What is the mushroom body?', { plan: ANATOMY_PLAN })
  assert.match(prompt, /Write the answer, never where the answer came from/)
  const rule = prompt.indexOf('Write the answer, never where the answer came from')
  const guidance = prompt.indexOf('WRITING GUIDANCE')
  assert.ok(guidance === -1 || guidance < rule, 'guidance must precede the closing rule')
  assert.match(prompt.slice(rule), /^[^]*Write the answer\.\s*$/, 'nothing but the sign-off may follow the closing rule')
})

test('a documentation answer gets the doc block and NOT the doc-miss block', async () => {
  // The two are opposites — one says a page answered, the other says none did.
  // Both present at once is the state that produced answers simultaneously
  // giving the steps and apologising for not having them.
  const prompt = await synthPrompt('How do I connect Claude to the VFB MCP server?', {
    plan: { intent: 'documentation', underspecified: false, clarifying_question: '', terms_to_resolve: [], steps: [] },
    docAnswers: true, stepEvidence: true
  })
  assertBlocks(prompt, ['docAnswered', 'docGapWording'], 'documentation answered')
})

test('the copyable-block instruction is scoped to a page that carries a block', async () => {
  // Said unconditionally it fenced a support email address, a list of API
  // section headings, and a plain English sentence, and its vocabulary bled into
  // answers with no code in them at all ("the exact configuration to access
  // these materials is not specified").
  const withBlock = await synthPrompt('How do I configure the VFB MCP server?', {
    plan: { intent: 'documentation', underspecified: false, clarifying_question: '', terms_to_resolve: [], steps: [] },
    docAnswers: true,
    docPage: 'Configure it like this:\n\n```json\n{\n  "mcpServers": {\n    "vfb": { "url": "https://vfb3-mcp.virtualflybrain.org" }\n  }\n}\n```\n'
  })
  assert.match(withBlock, BLOCKS.copyable, 'a page with a fenced block must ask for it whole')

  const withoutBlock = await synthPrompt('How do I contact VFB support?', {
    plan: { intent: 'documentation', underspecified: false, clarifying_question: '', terms_to_resolve: [], steps: [] },
    docAnswers: true, docPage: 'Email support@virtualflybrain.org for help.'
  })
  assert.ok(!BLOCKS.copyable.test(withoutBlock), 'a page with no block must not ask for one')
})

test('an unmatched name on a question about VFB itself never asks which term was meant', async () => {
  // "What do confidence values mean on VFB?" and "When did predicted
  // neurotransmitters for EM data become available?" are about a UI feature and
  // a release milestone. Neither has an ontology entry, so failing to find one
  // is not a finding — yet both answers were nothing but the naming failure.
  const prompt = await synthPrompt('What do confidence values mean on VFB?', {
    plan: { intent: 'other', underspecified: false, clarifying_question: '', terms_to_resolve: ['confidence values'], steps: [] },
    resolves: false, candidates: [], stepEvidence: false
  })
  assert.match(prompt, BLOCKS.unmatched, 'the naming failure is still declared')
  assert.ok(!BLOCKS.askWhichMeant.test(prompt), 'but must not ask the reader which term was meant')
  assert.match(prompt, BLOCKS.docGapWording, 'and must offer the documentation-absence wording instead')
})

test('an unmatched anatomical name does ask which term was meant', async () => {
  // The mirror of the previous test. Scoping a rule away from one shape must not
  // quietly remove it from the shape it was written for.
  const prompt = await synthPrompt('What is MBON-a1?', {
    plan: {
      intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: ['MBON-a1'],
      steps: [{ id: 's1', tool: 'vfb_get_term_info', answers: ['what is MBON-a1'] }]
    },
    resolves: false, candidates: ['mushroom body output neuron', 'adult mushroom body'], stepEvidence: false
  })
  assert.match(prompt, BLOCKS.unmatched)
  assert.match(prompt, BLOCKS.askWhichMeant)
  assert.match(prompt, /mushroom body output neuron; adult mushroom body/, 'the near misses are offered')
})

test('the available-data catalogue reaches every data question, and no definitional one', async () => {
  // The gate used to be "did any step answer?", and that was the bug: one query
  // running was enough to take the whole block down, prohibition included, so
  // the next sentence could freely deny the four queries that had not run.
  //
  // What that gate was really written for was a REAL defect — supplied as a
  // licence, the catalogue became a tail on every answer: the LPLC2 similarity
  // answer came back fully scored and correct, then closed with "VFB holds
  // various data related to LPLC2, including available images, splits …". The
  // fix is to split the block's two jobs rather than suppress both. Forbidding a
  // denial is unconditional; licensing a recital is scoped to WORTH SAYING.
  //
  // So the surviving gate is about the QUESTION, not the ledger. A definitional
  // question is answered by the term description; it makes no data claim, so
  // there is no absence to guard and nothing to be constructive about.
  //
  // Not a "what is X?" question below: that shape is claimed by detectFastPath,
  // which plans a term-info step whatever the plan says.
  const thin = await synthPrompt('Which GAL4 lines label the mushroom body?', {
    plan: {
      intent: 'genetic_tools', underspecified: false, clarifying_question: '', terms_to_resolve: ['mushroom body'],
      steps: [{ id: 's1', tool: 'vfb_find_genetic_tools', answers: ['which GAL4 lines label the mushroom body'] }]
    },
    stepEvidence: false
  })
  assert.match(thin, BLOCKS.available, 'a data question gets the catalogue')

  const definitional = await synthPrompt('What is the mushroom body?', { plan: ANATOMY_PLAN })
  assert.ok(!BLOCKS.available.test(definitional), 'a definitional question does not')
})

test('the catalogue arrives as a prohibition, and absence needs a lookup that happened', async () => {
  // Seven of twenty workshop answers denied records this very block was
  // advertising — "VFB does not currently hold data on the input and output
  // neurons of the mushroom body", over 366 presynaptic and 304 postsynaptic.
  // The old gate ("only say VFB lacks something if AVAILABLE VFB DATA shows
  // nothing relevant") could not tell QUERIED AND EMPTY from NEVER QUERIED, and
  // a permission loses to a rule. Both halves are pinned here: the block says
  // its queries are unrun, and the system rule keys absence on a lookup.
  //
  // TWO digest queries, deliberately. One is picked up and run by the
  // sufficiency injector and fails extraction, landing in TRIED, NO RESULT; the
  // other is never attempted and stays HELD. That is the exact pair the old
  // model could not tell apart — it called both of them "nothing relevant" —
  // and each licenses a different sentence, so both groups are asserted here.
  const thin = await synthPrompt('Which GAL4 lines label the mushroom body?', {
    plan: {
      intent: 'genetic_tools', underspecified: false, clarifying_question: '', terms_to_resolve: ['mushroom body'],
      steps: [{ id: 's1', tool: 'vfb_find_genetic_tools', answers: ['which GAL4 lines label the mushroom body'] }]
    },
    stepEvidence: false,
    digestQueries: [{ label: 'NeuronsPartHere', count: 12 }, { label: 'TransgeneExpressionHere', count: 40 }]
  })
  assert.match(thin, /HAVE NOT BEEN RUN/, 'the catalogue must say these are unrun, not empty')
  assert.match(thin, /NeuronsPartHere \(12\)/, 'with the held count attached to it')
  assert.match(thin, /FORBIDDEN/, 'and forbid an absence about anything it covers')

  // A lookup that fell over says nothing about the holdings, so it may not be
  // reported as an absence either — and the count stays on the line, because
  // "VFB holds 40 records here and the lookup did not complete" is an answer
  // where "the lookup did not complete" on its own is a shrug.
  assert.match(thin, /TRIED, NO RESULT/, 'a failed lookup is its own state')
  assert.match(thin, /TransgeneExpressionHere \(40\)/, 'and keeps the count it is holding')

  // The prohibition is unconditional; the LICENCE to name a query is not. This
  // question's one relevant query was already attempted, so nothing qualifies.
  assert.ok(!/WORTH SAYING/.test(thin), 'nothing unrun answers this question, so nothing is offered')
  assert.match(thin, /Do not list the HELD group back to the reader/, 'and the rest is explicitly not for reciting')

  const system = lastSynthMessages[0].content
  assert.match(system, /ABSENCE REQUIRES A LOOKUP THAT HAPPENED/)
  assert.match(system, /RUN, CAME BACK EMPTY — this state, and only this state, licenses an absence/,
    'absence is keyed on a query that ran and returned nothing, not on an empty block')
  assert.ok(!/Only say VFB lacks something if AVAILABLE VFB DATA/.test(system),
    'the old permission-shaped gate must not come back')
})

test('card guidance reaches only the questions its matcher claims', async () => {
  // guidanceCards.mjs is the one place this codebase already does scoping right.
  // This pins that it stays right end to end, not just in the card unit tests.
  const similarity = await synthPrompt('What neurons are morphologically similar to LPLC2?', {
    plan: { intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: ['LPLC2'], steps: [{ id: 's1', tool: 'vfb_get_term_info', answers: ['similar neurons'] }] }
  })
  assert.match(similarity, BLOCKS.guidance)
  assert.match(similarity, /nearest neighbours/, 'the similarity card, specifically')

  const anatomy = await synthPrompt('What is the mushroom body?', { plan: ANATOMY_PLAN })
  assert.ok(!/nearest neighbours/.test(anatomy), 'the similarity card must not reach an anatomy question')
})

// --- the code handoff --------------------------------------------------------
// Production, twice. Asked "how would I get that same result in Python with
// vfbquery?", the answer carried `vc.oc.get_instances`, `gen_short_form` and a
// `vfb_type_2_skids` helper that exists nowhere in VFB_connect. Displacing the
// snippet fixed the code and not the sentences: asked again with the grounded
// block present, the prose spent four paragraphs arguing that vfb_connect
// "does not show a direct command that accepts a region name like medulla to
// return all constituent neurons in one step" — directly above a one-line
// command that does exactly that.
//
// Recalled API knowledge reads exactly like retrieved fact, so the fix is to
// take the subject away rather than ask for more care.

test('a question asking for code gets the code-supplied block', async () => {
  const prompt = await synthPrompt('How would I get the mushroom body data in Python with vfbquery?',
    { plan: ANATOMY_PLAN })
  assert.ok(BLOCKS.codeSupplied.test(prompt), 'the block fires when the question asks for code')
  assert.match(prompt, /do NOT write code, in any language/)
  assert.match(prompt, /do NOT say what a library can or cannot do/)
  assert.match(prompt, /"in one step" or "directly"/,
    'the exact phrasing the failure used is named, so the instruction is about something concrete')
  // The first version only forbade naming a function, and the model answered
  // "you would use VFB function with the query type NeuronsPartHere" — a
  // sentence that names no mechanism and then points at one.
  assert.match(prompt, /Do not gesture at an unnamed one either/)
  // And it has to outrank EVIDENCE explicitly. A reviewed-docs page about
  // `get_similar_neurons` was in evidence, so the answer kept explaining what
  // that method is for and contrasting it with the question — about a method
  // the reader never mentioned.
  assert.match(prompt, /This overrides EVIDENCE/)
  assert.match(prompt, /get_similar_neurons is designed for morphology/)
})

test('an ordinary question never sees it', async () => {
  // The block that fires on every question is the block that costs every answer.
  for (const q of ['What is the mushroom body?', 'Which neurons receive output from the medulla?',
                   'What neurotransmitter do Kenyon cells use?']) {
    const prompt = await synthPrompt(q, { plan: ANATOMY_PLAN })
    assert.ok(!BLOCKS.codeSupplied.test(prompt), `must be absent for "${q}"`)
  }
})

test('it is read after the documentation blocks and before the closing rule', async () => {
  // Order is load-bearing here: the last thing read wins, and the doc block has
  // already taken a rule down with it once by growing past it.
  const prompt = await synthPrompt('How do I get the mushroom body in vfb_connect?', { plan: ANATOMY_PLAN })
  const code = prompt.indexOf('CODE IS ALREADY SUPPLIED')
  const closing = prompt.indexOf('Write the answer, never where the answer came from')
  assert.ok(code > 0 && closing > code, 'the closing rule still reads last')
})
