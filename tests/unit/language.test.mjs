// Answering in the user's language: the decision, the translation check, and
// the two places the harness reads the decision.
//
// The cases are the Cologne table, 10 September 2026 (feedback transcripts):
//   - "chand ta driverline dar flywire data vojood dare?" — Persian in Latin
//     letters — got an English clarifying question back.
//   - "sorold fel az ellipszis testet jelolo GAL4 torzseket, valaszolj magyarul"
//     was answered in Hungarian with no links, and said 327 where the table
//     under it said 392.
//   - "can you reply in persian?" was answered "yes, I can — how can I help?"
//     instead of with the previous answer in Persian.
//
// Run: node --test tests/unit/language.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normaliseLanguageCode, languageName, isEnglish, isRightToLeft, sanitizeLang, decideTurnLanguage } from '../../lib/language.mjs'
import { normalizePlan, acceptBareLanguageRequest, votePlanWithEscalation } from '../../lib/planner.mjs'
import { sanitizeContext, mergeContext, buildTurnContext, CONTEXT_VERSION } from '../../lib/conversationContext.mjs'
import {
  linkTargets, proseNumbers, vfbIds, asciiDigits, checkTranslation, translationMessages,
  translateMarkdown, translateChipLabels, translationFallbackNote, chipLabelMessages
} from '../../lib/translateAnswer.mjs'
import { runHarness, englishNameFor } from '../../lib/orchestrator.mjs'
import { checkTurn, scriptShare, englishStopwordRatio } from '../../lib/battery/conversation.mjs'

// --- codes -------------------------------------------------------------------

test('a code, a tag, or a name all normalise to the primary subtag', () => {
  assert.equal(normaliseLanguageCode('fa'), 'fa')
  assert.equal(normaliseLanguageCode('fa-IR'), 'fa')
  assert.equal(normaliseLanguageCode(' Persian '), 'fa')
  assert.equal(normaliseLanguageCode('Farsi (Latin script)'), 'fa')
  assert.equal(normaliseLanguageCode('Hungarian'), 'hu')
  assert.equal(normaliseLanguageCode('zh-Hant'), 'zh')
  assert.equal(normaliseLanguageCode('EN'), 'en')
  assert.equal(normaliseLanguageCode(''), '')
  assert.equal(normaliseLanguageCode('unknown'), '')
  assert.equal(normaliseLanguageCode(42), '')
  assert.equal(normaliseLanguageCode('yue'), 'yue', 'any ISO 639 alpha code is a code, table or no table')
  assert.equal(normaliseLanguageCode('haw-US'), 'haw')
})

test('names, direction, and what counts as English', () => {
  assert.equal(languageName('fa'), 'Persian')
  assert.equal(languageName('hu'), 'Hungarian')
  assert.equal(languageName(''), 'English')
  assert.equal(languageName('xx'), 'xx', 'an unknown code is passed through, never invented')
  assert.equal(isEnglish(''), true)
  assert.equal(isEnglish('en'), true)
  assert.equal(isEnglish('English'), true)
  assert.equal(isEnglish('fa'), false)
  assert.equal(isRightToLeft('fa'), true)
  assert.equal(isRightToLeft('hu'), false)
})

test('sanitizeLang accepts only a shape with a real code', () => {
  assert.deepEqual(sanitizeLang({ code: 'fa', pinned: true }), { code: 'fa', pinned: true })
  assert.deepEqual(sanitizeLang({ code: 'Persian', pinned: 'yes' }), { code: 'fa', pinned: false })
  assert.equal(sanitizeLang({ code: 'gibberish' }), null)
  assert.equal(sanitizeLang('fa'), null)
  assert.equal(sanitizeLang(null), null)
})

// --- the decision ------------------------------------------------------------

test('a typed question is answered in the language the planner read', () => {
  const d = decideTurnLanguage({ planLanguage: 'hu', priorLang: null, via: 'planner' })
  assert.equal(d.code, 'hu')
  assert.deepEqual(d.lang, { code: 'hu', pinned: false })
})

test('romanised Persian read as fa is answered in Persian', () => {
  assert.equal(decideTurnLanguage({ planLanguage: 'fa' }).code, 'fa')
})

test('an explicit request pins the conversation, whatever the message was written in', () => {
  const d = decideTurnLanguage({ planLanguage: 'en', requestedLanguage: 'Persian' })
  assert.equal(d.code, 'fa')
  assert.deepEqual(d.lang, { code: 'fa', pinned: true })
  assert.equal(d.pinnedByThisTurn, true)
})

test('a pinned language survives an English typed turn and a clicked chip', () => {
  const prior = { code: 'fa', pinned: true }
  assert.equal(decideTurnLanguage({ planLanguage: 'en', priorLang: prior, via: 'planner' }).code, 'fa')
  assert.equal(decideTurnLanguage({ priorLang: prior, via: 'focus' }).code, 'fa')
  assert.equal(decideTurnLanguage({ priorLang: prior, via: 'fast-path' }).code, 'fa')
})

test('a new explicit request replaces a pin', () => {
  const d = decideTurnLanguage({ requestedLanguage: 'de', priorLang: { code: 'fa', pinned: true } })
  assert.deepEqual(d.lang, { code: 'de', pinned: true })
})

test('an unpinned conversation: chips inherit, typed English turns are English', () => {
  const prior = { code: 'hu', pinned: false }
  assert.equal(decideTurnLanguage({ priorLang: prior, via: 'focus' }).code, 'hu', 'a clicked chip carries an English query the user did not write')
  assert.equal(decideTurnLanguage({ planLanguage: 'en', priorLang: prior, via: 'planner' }).code, 'en')
  assert.equal(decideTurnLanguage({ priorLang: prior, via: 'template' }).code, 'en', 'a template match is English syntax')
  assert.equal(decideTurnLanguage({ priorLang: prior, via: 'context-chip' }).code, 'en')
})

test('no information at all is English', () => {
  assert.equal(decideTurnLanguage({}).code, 'en')
  assert.equal(decideTurnLanguage({ planLanguage: 'gibberish' }).code, 'en')
})

// --- the planner's fields ----------------------------------------------------

test('normalizePlan carries the language fields through and tolerates their absence', () => {
  const p = normalizePlan({ intent: 'other', steps: [], language: ' hu ', requested_language: '', language_request_only: false })
  assert.equal(p.language, 'hu')
  assert.equal(p.requested_language, '')
  assert.equal(p.language_request_only, false)
  const old = normalizePlan({ intent: 'other', steps: [] })
  assert.equal(old.language, '')
  assert.equal(old.requested_language, '')
  assert.equal(old.language_request_only, false)
})

test('a bare language request is only honoured when the plan really is bare', () => {
  const bare = normalizePlan({ intent: 'other', steps: [], terms_to_resolve: [], language: 'en', requested_language: 'fa', language_request_only: true, underspecified: true, clarifying_question: 'Which language?' })
  assert.equal(bare.language_request_only, true)
  assert.equal(bare.underspecified, false, 'a language request is never a clarification')
  assert.equal(bare.clarifying_question, '')

  const withLookup = normalizePlan({ intent: 'term_info', steps: [{ id: 's1', tool: 'vfb_get_term_info', answers: ['x'] }], terms_to_resolve: ['ellipsoid body'], language: 'hu', requested_language: 'hu', language_request_only: true })
  assert.equal(withLookup.language_request_only, false, 'a planner that also planned a lookup misread the message; the lookup wins')
  assert.equal(withLookup.requested_language, 'hu', 'the request still pins the language')

  const noCode = normalizePlan({ intent: 'other', steps: [], language: 'en', requested_language: '', language_request_only: true })
  assert.equal(noCode.language_request_only, false, 'a request with no language named is not a request')
})

test('a bare language request is accepted from round one, unless any vote found something to resolve', async () => {
  const bare = { intent: 'other', underspecified: false, clarifying_question: '', terms_to_resolve: [], steps: [], language: 'en', requested_language: 'fa', language_request_only: true }
  const docs = { intent: 'documentation', underspecified: false, clarifying_question: '', terms_to_resolve: [], steps: [{ id: 's1', tool: 'search_reviewed_docs', answers: ['x'] }], language: 'en', requested_language: 'fa', language_request_only: false }
  const entity = { ...docs, terms_to_resolve: ['mushroom body'] }
  assert.equal(acceptBareLanguageRequest([docs, bare, docs]), bare)
  assert.equal(acceptBareLanguageRequest([docs, bare, entity]), null, 'a vote that extracted an entity means the message asked something')
  assert.equal(acceptBareLanguageRequest([docs, docs]), null)
  assert.equal(acceptBareLanguageRequest([]), null)

  // Through the vote: no escalation round is bought for it.
  let sampled = 0
  const r = await votePlanWithEscalation({
    votes: 3,
    policy: { minAgreement: 0.67, extraVotes: 3, maxRounds: 1 },
    sample: async () => { sampled++; return [docs, bare, { ...docs, intent: 'other' }] },
    vote: (pool) => ({ value: pool[0], agreement: 1 / 3 }),
    accept: acceptBareLanguageRequest
  })
  assert.equal(r.ok, true)
  assert.equal(r.value, bare)
  assert.equal(r.escalated, false)
  assert.equal(sampled, 1, 'one round only')
  assert.equal(r.rounds[0].accepted, true)
})

// --- the context -------------------------------------------------------------

test('the context carries a validated lang block, and this turn wins over the last', () => {
  const clean = sanitizeContext({ v: CONTEXT_VERSION, terms: [], registry: [], lang: { code: 'Persian', pinned: true } })
  assert.deepEqual(clean.lang, { code: 'fa', pinned: true })
  assert.equal(sanitizeContext({ v: CONTEXT_VERSION, terms: [], registry: [], lang: { code: 'nope' } }).lang, null)
  assert.equal(sanitizeContext(null).lang, null)

  const prev = { v: CONTEXT_VERSION, terms: [], registry: [], lang: { code: 'hu', pinned: false } }
  const turn = { v: CONTEXT_VERSION, terms: [], registry: [], lang: { code: 'fa', pinned: true } }
  assert.deepEqual(mergeContext(prev, turn).lang, { code: 'fa', pinned: true })
  assert.deepEqual(mergeContext(prev, { v: CONTEXT_VERSION, terms: [], registry: [] }).lang, { code: 'hu', pinned: false }, 'a turn that decided nothing keeps the conversation language')
})

test('buildTurnContext writes the ledger decision into the context', () => {
  assert.deepEqual(buildTurnContext({ terms: {}, registry: {}, langContext: { code: 'fa', pinned: true } }).lang, { code: 'fa', pinned: true })
  assert.equal(buildTurnContext({ terms: {}, registry: {} }).lang, null)
})

// --- the translation check ---------------------------------------------------

const EN = [
  'The [ellipsoid body](https://www.virtualflybrain.org/reports/FBbt_00003678 "Open ellipsoid body in Virtual Fly Brain") is a neuropil.',
  'VFB holds [392](https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?q=FBbt_00003678,TransgeneExpressionHere "Run in VFB") driver lines, 1,335 images and 3 subclasses (FBbt_00003678).'
].join('\n\n')

test('link targets are read to the closing paren, titles and all', () => {
  assert.deepEqual(linkTargets(EN), [
    'https://www.virtualflybrain.org/reports/FBbt_00003678',
    'https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?q=FBbt_00003678,TransgeneExpressionHere'
  ])
  assert.deepEqual(linkTargets('see https://flybase.org/reports/FBgn0000014 now'), ['https://flybase.org/reports/FBgn0000014'])
})

test('prose numbers are canonical digit strings, and never come from a URL', () => {
  assert.deepEqual(proseNumbers(EN).sort(), ['1335', '3', '392'].sort())
  assert.deepEqual(proseNumbers('1 335 cells and 2.5 mm'), ['1335', '25'])
  assert.deepEqual(vfbIds(EN), ['FBbt_00003678'])
  assert.equal(asciiDigits('۳۹۲ and ٣'), '392 and 3')
  // Every script's digits, not a hand-picked few: Thai, Bengali, Devanagari,
  // Myanmar, fullwidth, and a digit run inside a symbol left alone.
  assert.equal(asciiDigits('๓๙๒ ৩৯২ ३९२ ၃၉၂ ３９２'), '392 392 392 392 392')
  assert.deepEqual(proseNumbers('R66A08 and GAL4 drive 12 cells'), ['12'])
})

test('a faithful translation passes, whichever digits it used', () => {
  const hu = EN
    .replace('is a neuropil.', '(ellipszis test) egy neuropil.')
    .replace('driver lines, 1,335 images and 3 subclasses', 'driver vonalat, 1 335 képet és 3 alosztályt tart nyilván')
  assert.equal(checkTranslation(EN, hu).ok, true)
  const fa = EN.replace('392', '۳۹۲').replace('1,335', '۱٬۳۳۵')
  const check = checkTranslation(EN, fa)
  assert.equal(check.ok, true, check.reason)
})

test('a translation that dropped a link, a number or an id fails, and says which', () => {
  const noLink = EN.replace('[392](https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?q=FBbt_00003678,TransgeneExpressionHere "Run in VFB")', '392')
  const c1 = checkTranslation(EN, noLink)
  assert.equal(c1.ok, false)
  assert.equal(c1.missing.urls.length, 1)
  assert.match(c1.reason, /1 link/)

  const wrongNumber = EN.replace('1,335', '1,325')
  const c2 = checkTranslation(EN, wrongNumber)
  assert.equal(c2.ok, false)
  assert.deepEqual(c2.missing.numbers, ['1335'])

  const noId = EN.replace(' (FBbt_00003678)', '')
  const c3 = checkTranslation(EN, noId)
  assert.equal(c3.ok, false)
  assert.deepEqual(c3.missing.ids, ['FBbt_00003678'])
})

test('an empty or wildly resized output fails', () => {
  assert.equal(checkTranslation(EN, '').ok, false)
  const long = 'x'.repeat(300)
  assert.equal(checkTranslation(long, 'short').reason.startsWith('length ratio'), true)
})

test('the prompt names the language, the invariants, and what a retry must fix', () => {
  const m = translationMessages({ text: EN, language: 'hu' })
  assert.equal(m[0].role, 'system')
  assert.match(m[0].content, /into Hungarian/)
  assert.match(m[0].content, /character for character/)
  assert.match(m[1].content, /Translate into Hungarian\.$/)
  assert.match(translationMessages({ text: EN, language: 'yue' })[0].content, /into yue,/, 'a code the name table does not know is still asked for')
  const retry = translationMessages({ text: EN, language: 'hu', missing: { urls: ['https://x'], numbers: ['392'], ids: [] } })
  assert.match(retry[1].content, /dropped or altered: the link https:\/\/x; the number 392/)
  const clar = translationMessages({ text: 'Which one?', language: 'fa', kind: 'clarification' })
  assert.match(clar[0].content, /clarifying question/)
})

test('translateMarkdown: English and empty text are returned untouched, with no call', async () => {
  let calls = 0
  const call = async () => { calls++; return 'x' }
  assert.deepEqual(await translateMarkdown({ text: EN, language: 'en', call }), { ok: true, text: EN, attempts: 0, reason: 'not needed' })
  assert.equal((await translateMarkdown({ text: '  ', language: 'fa', call })).attempts, 0)
  assert.equal(calls, 0)
})

test('translateMarkdown: a verified first attempt ships', async () => {
  const hu = EN.replace('is a neuropil', 'egy neuropil')
  const r = await translateMarkdown({ text: EN, language: 'hu', call: async () => hu })
  assert.equal(r.ok, true)
  assert.equal(r.text, hu)
  assert.equal(r.attempts, 1)
})

test('translateMarkdown: a dropped link is retried with the complaint, and the client drops the draft', async () => {
  const bad = EN.replace('[392](https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?q=FBbt_00003678,TransgeneExpressionHere "Run in VFB")', '392')
  const good = EN.replace('is a neuropil', 'egy neuropil')
  const seen = []
  let discarded = 0
  const r = await translateMarkdown({
    text: EN, language: 'hu',
    call: async ({ messages, attempt }) => { seen.push(messages[1].content); return attempt === 1 ? bad : good },
    onDiscard: () => { discarded++ }
  })
  assert.equal(r.ok, true)
  assert.equal(r.attempts, 2)
  assert.equal(discarded, 1)
  assert.match(seen[1], /dropped or altered: the link/)
})

test('translateMarkdown: two failures give up honestly with the English', async () => {
  const r = await translateMarkdown({ text: EN, language: 'hu', call: async () => 'rövid' })
  assert.equal(r.ok, false)
  assert.equal(r.text, EN)
  assert.equal(r.attempts, 2)
  assert.ok(r.reason)
  assert.match(translationFallbackNote('hu'), /shown in English/)
  assert.match(translationFallbackNote('hu'), /Hungarian/)
})

test('translateMarkdown: a throwing call counts as a failed attempt', async () => {
  let n = 0
  const r = await translateMarkdown({ text: EN, language: 'hu', call: async () => { n++; throw new Error('gateway 502') } })
  assert.equal(r.ok, false)
  assert.equal(n, 2)
  assert.match(r.reason, /gateway 502/)
})

// --- chips -------------------------------------------------------------------

const CHIPS = ['Which driver lines label the ellipsoid body? (392)', 'Which neurons have synaptic terminals in the ellipsoid body? (102)']

test('chip labels are translated one for one; the query is never touched', async () => {
  const labels = await translateChipLabels({
    labels: CHIPS, language: 'hu',
    callStructured: async ({ messages, schemaName }) => {
      assert.equal(schemaName, 'chip_labels')
      assert.match(messages[0].content, /into Hungarian/)
      return { ok: true, value: { labels: ['Mely driver vonalak jelölik az ellipsoid body-t? (392)', 'Mely neuronoknak vannak szinaptikus végződései az ellipsoid body-ban? (102)'] } }
    }
  })
  assert.equal(labels.length, 2)
  assert.match(labels[0], /^Mely/)
  assert.match(chipLabelMessages(CHIPS, 'fa')[1].content, /392/)
})

test('chip labels fall back to English on any shape mismatch, and per label when a count is lost', async () => {
  assert.deepEqual(await translateChipLabels({ labels: CHIPS, language: 'en', callStructured: async () => { throw new Error('never') } }), CHIPS)
  assert.deepEqual(await translateChipLabels({ labels: CHIPS, language: 'hu', callStructured: async () => ({ ok: true, value: { labels: ['only one'] } }) }), CHIPS)
  assert.deepEqual(await translateChipLabels({ labels: CHIPS, language: 'hu', callStructured: async () => ({ ok: false }) }), CHIPS)
  assert.deepEqual(await translateChipLabels({ labels: CHIPS, language: 'hu', callStructured: async () => { throw new Error('502') } }), CHIPS)
  const partial = await translateChipLabels({ labels: CHIPS, language: 'hu', callStructured: async () => ({ ok: true, value: { labels: ['Mely driver vonalak? (392)', 'Mely neuronok?'] } }) })
  assert.equal(partial[0], 'Mely driver vonalak? (392)')
  assert.equal(partial[1], CHIPS[1], 'the label that lost its count keeps its English')
})

// --- the battery's language checks ------------------------------------------

test('scriptShare and englishStopwordRatio read the prose, not the links', () => {
  const fa = 'VFB تعداد [70](https://v2.virtualflybrain.org/x "Run in VFB") نوع نورون را برای [ellipsoid body](https://www.virtualflybrain.org/reports/FBbt_00003678 "Open") ثبت کرده است.'
  assert.ok(scriptShare(fa, 'Arabic') > 0.7, 'the English label inside the link text does not count against the Persian')
  assert.ok(scriptShare(fa, 'Latin') < 0.3)
  assert.equal(scriptShare('', 'Arabic'), 0)
  assert.equal(scriptShare('abc', 'NotAScript'), 0)
  const hu = 'A VFB jelenleg [392](https://v2.virtualflybrain.org/x "Run in VFB") transzgén expressziós jelentést tart nyilván az ellipszis testre (ellipsoid body) vonatkozóan.'
  assert.ok(englishStopwordRatio(hu) < 0.06, `hungarian ratio ${englishStopwordRatio(hu)}`)
  const en = 'VFB holds 392 transgene expression reports for the ellipsoid body, and these are the ones with GAL4 drivers.'
  assert.ok(englishStopwordRatio(en) > 0.2, `english ratio ${englishStopwordRatio(en)}`)
})

test('checkTurn: the language expectations name what went wrong', () => {
  const en = 'VFB holds [392](https://v2.virtualflybrain.org/x "Run in VFB") reports for the ellipsoid body.'
  const problems = checkTurn(
    { answer_script: 'Arabic', answer_not_english: true, context_lang: { code: 'fa', pinned: true }, min_links: 2 },
    { answer: en, followOns: [], context: { lang: { code: 'fa', pinned: false } } }
  )
  assert.equal(problems.length, 4, problems.join('\n'))
  assert.match(problems[0], /not written in the Arabic script/)
  assert.match(problems[1], /reads as English/)
  assert.match(problems[2], /not pinned, expected pinned/)
  assert.match(problems[3], /at least 2 link/)
  assert.deepEqual(checkTurn({ context_lang: 'hu' }, { answer: 'x', followOns: [], context: {} }), ['context language is unset, expected hu'])
  const fa = 'VFB تعداد [70](https://v2.virtualflybrain.org/x "Run in VFB") نوع نورون را ثبت کرده است.'
  assert.deepEqual(checkTurn({ answer_script: 'Arabic', answer_not_english: true, context_lang: 'fa', min_links: 1 }, { answer: fa, followOns: [], context: { lang: { code: 'fa', pinned: true } } }), [])
})

// --- the harness -------------------------------------------------------------

const TOOL_DEFS = [
  { name: 'vfb_search_terms', purpose: 'search terms', parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, rows: { type: 'number' }, minimize_results: { type: 'boolean' } } } },
  { name: 'vfb_get_term_info', purpose: 'term info', parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
]
const EB = { short_form: 'FBbt_00003678', label: 'EB (ellipsoid body)', original_label: 'ellipsoid body', facets_annotation: ['Anatomy', 'Class'] }

function makeDeps({ plan, hits = {}, englishName = '', context = null, focus = null }) {
  const calls = { searches: [], structured: [], synth: [] }
  return {
    calls,
    toolDefs: TOOL_DEFS,
    models: { planner: 'm', extract: 'm', synth: 'm' },
    maxToolRounds: 4,
    context,
    focus,
    async callStructured({ schemaName }) {
      calls.structured.push(schemaName)
      if (schemaName === 'plan') return { ok: true, value: plan }
      if (schemaName === 'english_term_name') return englishName ? { ok: true, value: { english_name: englishName } } : { ok: false }
      if (schemaName === 'extract') return { ok: true, value: { relevant: true, answered: true, claim: 'c', verbatim: 'v' } }
      return { ok: false }
    },
    async callText(o) { calls.synth.push(o); return 'FINAL ANSWER' },
    async runTool(name, args) {
      if (name === 'vfb_search_terms') {
        calls.searches.push(args.query)
        const docs = hits[args.query]
        return docs ? { response: { docs } } : { response: { docs: [] } }
      }
      if (name === 'vfb_get_term_info') return { Id: args.id, Name: 'ellipsoid body', Publications: [] }
      return { ok: true }
    }
  }
}

test('a Hungarian question is answered in Hungarian: the ledger says so and the English draft is silent', async () => {
  const deps = makeDeps({
    plan: { intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: ['ellipsoid body'], steps: [], language: 'hu', requested_language: '', language_request_only: false },
    hits: { 'ellipsoid body': [EB] }
  })
  const r = await runHarness('sorold fel az ellipszis testet jelolo GAL4 torzseket', deps)
  assert.equal(r.ledger.language, 'hu')
  assert.deepEqual(r.ledger.langContext, { code: 'hu', pinned: false })
  assert.equal(r.ledger.terms['ellipsoid body'].id, 'FBbt_00003678')
  assert.ok(deps.calls.synth.length >= 1)
  assert.equal(deps.calls.synth[0].silent, true, 'the English draft is accumulated, not shown')
  assert.ok(r.trace.some(e => e.step === 'language' && e.code === 'hu'))
})

test('an English question streams as before', async () => {
  const deps = makeDeps({
    plan: { intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: ['ellipsoid body'], steps: [], language: 'en', requested_language: '', language_request_only: false },
    hits: { 'ellipsoid body': [EB] }
  })
  const r = await runHarness('Tell me about the ellipsoid body and its driver lines', deps)
  assert.equal(r.ledger.language, 'en')
  assert.equal(deps.calls.synth[0].silent, false)
  assert.ok(!deps.calls.structured.includes('english_term_name'), 'no translation rung on an English turn')
})

test('the translation rung: a name the planner copied as written is resolved through its English name', async () => {
  const deps = makeDeps({
    plan: { intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: ['ellipszis test'], steps: [], language: 'hu', requested_language: '', language_request_only: false },
    hits: { 'ellipsoid body': [EB] },
    englishName: 'ellipsoid body'
  })
  const r = await runHarness('mi az ellipszis test?', deps)
  assert.equal(r.ledger.terms['ellipszis test'].id, 'FBbt_00003678')
  assert.ok(deps.calls.structured.includes('english_term_name'))
  assert.ok(deps.calls.searches.includes('ellipsoid body'))
  assert.ok(r.trace.some(e => e.resolve_translation === 'ellipszis test' && e.as === 'ellipsoid body' && e.id === 'FBbt_00003678'))
})

test('the translation rung: no English name, no change — the term abstains as before', async () => {
  const deps = makeDeps({
    plan: { intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: ['valami'], steps: [], language: 'hu', requested_language: '', language_request_only: false },
    hits: {}, englishName: ''
  })
  const r = await runHarness('mi az a valami?', deps)
  assert.equal(r.ledger.terms['valami'].id, null)
})

test('englishNameFor refuses a sentence and survives a failed call', async () => {
  const deps = { async callStructured() { return { ok: true, value: { english_name: 'The ellipsoid body is a neuropil. It lies centrally.' } } } }
  assert.equal(await englishNameFor('x', 'hu', deps), '')
  assert.equal(await englishNameFor('x', 'hu', { async callStructured() { throw new Error('boom') } }), '')
  assert.equal(await englishNameFor('x', 'hu', { async callStructured() { return { ok: true, value: { english_name: ' ellipsoid body ' } } } }), 'ellipsoid body')
})

test('"can you reply in persian?" is a language switch: nothing looked up, the language pinned', async () => {
  const deps = makeDeps({
    plan: { intent: 'other', underspecified: false, clarifying_question: '', terms_to_resolve: [], steps: [], language: 'en', requested_language: 'fa', language_request_only: true }
  })
  const r = await runHarness('can you reply in persian?', deps)
  assert.equal(r.languageSwitch, true)
  assert.equal(r.answer, '')
  assert.equal(r.ledger.language, 'fa')
  assert.deepEqual(r.ledger.langContext, { code: 'fa', pinned: true })
  assert.equal(deps.calls.searches.length, 0)
  assert.equal(deps.calls.synth.length, 0)
})

test('a pinned conversation answers a typed English question in the pinned language', async () => {
  const deps = makeDeps({
    plan: { intent: 'term_info', underspecified: false, clarifying_question: '', terms_to_resolve: ['ellipsoid body'], steps: [], language: 'en', requested_language: '', language_request_only: false },
    hits: { 'ellipsoid body': [EB] },
    context: { v: CONTEXT_VERSION, terms: [], registry: [], lang: { code: 'fa', pinned: true } }
  })
  const r = await runHarness('Tell me about the ellipsoid body and its driver lines', deps)
  assert.equal(r.ledger.language, 'fa')
  assert.deepEqual(r.ledger.langContext, { code: 'fa', pinned: true })
})

test('a clicked chip inherits the conversation language', async () => {
  const deps = makeDeps({
    plan: null,
    hits: {},
    context: { v: CONTEXT_VERSION, terms: [], registry: [], lang: { code: 'hu', pinned: false } },
    focus: { id: 'FBbt_00003678', query_type: 'TransgeneExpressionHere' }
  })
  deps.runTool = async (name, args) => {
    if (name === 'vfb_get_term_info') return { Id: 'FBbt_00003678', Name: 'ellipsoid body', Publications: [] }
    if (name === 'vfb_run_query') return { rows: [], count: 0 }
    return { response: { docs: [] } }
  }
  deps.toolDefs = [...TOOL_DEFS, { name: 'vfb_run_query', purpose: 'run', parameters: { type: 'object', required: ['id', 'query_type'], properties: { id: { type: 'string' }, query_type: { type: 'string' } } } }]
  const r = await runHarness('Which driver lines label the ellipsoid body?', deps)
  assert.equal(r.ledger.language, 'hu')
  assert.ok(r.trace.some(e => e.step === 'language' && e.via === 'focus'))
})
