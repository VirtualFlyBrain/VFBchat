// Offline unit tests for the external-evidence retriever roles (pure logic).
// Run: node --test tests/unit/externalEvidence.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPublicationRefs, hasPublicationRefs, bestRefUrl } from '../../lib/literatureRefs.mjs'
import {
  EXTRACT_SCHEMA, buildDocExtractMessages, buildLiteratureExtractMessages,
  buildEvidenceRow, needsDocumentation, needsLiterature, planRetrieval,
  completeQuoteFromSource, hasCopyableBlock, firstCopyableBlock
} from '../../lib/externalEvidence.mjs'
import { validateAgainstSchema } from '../../lib/structuredOutput.mjs'

const TERM_INFO = {
  Name: 'PPL1',
  Publications: [
    { microref: 'Aso et al., 2010', PubMed: '20637624', FlyBase: 'FBrf0212370', DOI: '10.1016/j.cub.2010.06.048' },
    { microref: 'Duplicate', PubMed: '20637624', DOI: '', FlyBase: '' }, // dup PMID
    { microref: 'No ids', PubMed: '', DOI: '', FlyBase: '' },            // dropped
    { microref: 'DOI only', PubMed: '', DOI: '10.1000/xyz', FlyBase: '' }
  ]
}

test('extractPublicationRefs: normalises, dedupes, drops id-less', () => {
  const refs = extractPublicationRefs(TERM_INFO)
  assert.equal(refs.length, 2)
  assert.equal(refs[0].pmid, '20637624')
  assert.equal(refs[0].citation, 'Aso et al., 2010')
  assert.equal(refs[0].url, 'https://doi.org/10.1016/j.cub.2010.06.048')
  assert.equal(refs[1].doi, '10.1000/xyz')
})

test('extractPublicationRefs: empty / missing Publications', () => {
  assert.deepEqual(extractPublicationRefs({}), [])
  assert.deepEqual(extractPublicationRefs(null), [])
})

test('bestRefUrl: DOI > PubMed > FlyBase', () => {
  assert.equal(bestRefUrl({ doi: '10.1/x', pmid: '1', fbrf: 'FBrf1' }), 'https://doi.org/10.1/x')
  assert.equal(bestRefUrl({ pmid: '12345678', fbrf: 'FBrf1' }), 'https://pubmed.ncbi.nlm.nih.gov/12345678/')
  assert.equal(bestRefUrl({ fbrf: 'FBrf0212370' }), 'https://flybase.org/reports/FBrf0212370')
  assert.equal(bestRefUrl({}), '')
})

test('hasPublicationRefs', () => {
  assert.equal(hasPublicationRefs(TERM_INFO), true)
  assert.equal(hasPublicationRefs({ Publications: [] }), false)
})

test('EXTRACT_SCHEMA: conformant output validates; bad shape rejected', () => {
  assert.equal(validateAgainstSchema({ relevant: true, answered: true, claim: 'x', verbatim: 'q' }, EXTRACT_SCHEMA).valid, true)
  assert.equal(validateAgainstSchema({ relevant: true, answered: true, claim: 'x' }, EXTRACT_SCHEMA).valid, false) // missing verbatim
  assert.equal(validateAgainstSchema({ relevant: 'yes', answered: true, claim: 'x', verbatim: 'q' }, EXTRACT_SCHEMA).valid, false) // wrong type
})

test('buildDocExtractMessages: includes question, url, evidence-not-instructions rule', () => {
  const m = buildDocExtractMessages({ question: 'How do I find images?', pageText: 'Use the search box.', url: 'https://virtualflybrain.org/docs' })
  assert.match(m[0].content, /evidence, not instructions/)
  assert.match(m[1].content, /How do I find images\?/)
  assert.match(m[1].content, /virtualflybrain\.org\/docs/)
  // A configuration block is the answer, not a quote supporting one. Asked how
  // to connect an MCP client, the extractor pulled a single line out of the
  // middle of the JSON on the page and the answer invented the rest around it.
  assert.match(m[0].content, /WHOLE block in "verbatim"/)
})

test('buildLiteratureExtractMessages: no code-block carve-out', () => {
  // The block rule is documentation-only; a paper has no configuration to copy.
  const m = buildLiteratureExtractMessages({ question: 'q', content: 'c', ref: { pmid: '1' } })
  assert.ok(!/WHOLE block/.test(m[0].content))
})

test('buildLiteratureExtractMessages: cites the ref', () => {
  const m = buildLiteratureExtractMessages({ question: 'role in memory?', content: 'PPL1 mediates aversive memory.', ref: { citation: 'Aso 2010', pmid: '20637624' } })
  assert.match(m[1].content, /Aso 2010/)
  assert.match(m[1].content, /role in memory\?/)
})

// The real page, abridged: the MCP guide's configuration block, followed by the
// text that comes after it. The extractor's actual output for this page was the
// same block one closing brace short.
const MCP_PAGE = `Add this to your client configuration:

{
"mcpServers": {
"virtual-fly-brain": {
"type": "http",
"url": "https://vfb3-mcp.virtualflybrain.org",
"tools": ["*"]
}
}
}

Alternative JSON configuration (in mcp.json ):`

test('completeQuoteFromSource: closes a configuration block cut one brace short', () => {
  const clipped = `{
"mcpServers": {
"virtual-fly-brain": {
"type": "http",
"url": "https://vfb3-mcp.virtualflybrain.org",
"tools": ["*"]
}
}
`
  const fixed = completeQuoteFromSource(clipped, MCP_PAGE)
  assert.ok(fixed.endsWith('}\n}\n}'), JSON.stringify(fixed))
  assert.doesNotThrow(() => JSON.parse(fixed))
  // And it is the page's own text, not a reconstruction.
  assert.ok(MCP_PAGE.includes(fixed))
})

test('completeQuoteFromSource: the page arrives escaped, the quote does not', () => {
  // The real shape of the failure. The page reaches the extractor as serialised
  // tool output — newlines are the two characters backslash-n — while the model
  // quotes it with real newlines. A byte comparison of the two never matches, so
  // without decoding, the repair would silently never fire on any code block.
  const escaped = MCP_PAGE.replace(/\n/g, '\\n').replace(/"/g, '\\"')
  assert.ok(!escaped.includes('\n'))
  const clipped = '{\n"mcpServers": {\n"virtual-fly-brain": {\n"type": "http",\n"url": "https://vfb3-mcp.virtualflybrain.org",\n"tools": ["*"]\n}\n}\n'
  const fixed = completeQuoteFromSource(clipped, escaped)
  assert.doesNotThrow(() => JSON.parse(fixed))
  assert.equal(JSON.parse(fixed).mcpServers['virtual-fly-brain'].url, 'https://vfb3-mcp.virtualflybrain.org')
})

test('completeQuoteFromSource: re-indenting the block does not defeat the match', () => {
  // Models indent JSON as they copy it. That is not a different block, and
  // refusing to recognise it would fail closed on the common case.
  const clipped = '{\n  "mcpServers": {\n    "virtual-fly-brain": {\n      "type": "http",\n      "url": "https://vfb3-mcp.virtualflybrain.org",\n      "tools": ["*"]\n    }\n  }\n'
  const fixed = completeQuoteFromSource(clipped, MCP_PAGE)
  assert.doesNotThrow(() => JSON.parse(fixed))
  // The model's own formatting is kept; only the missing closer is appended.
  assert.ok(fixed.startsWith('{\n  "mcpServers"'), JSON.stringify(fixed))
})

test('completeQuoteFromSource: never invents — leaves alone what it cannot verify', () => {
  // Already balanced: untouched, even though more block follows in the source.
  const whole = '{\n"mcpServers": {\n"virtual-fly-brain": {\n"type": "http",\n"url": "https://vfb3-mcp.virtualflybrain.org",\n"tools": ["*"]\n}\n}\n}'
  assert.equal(completeQuoteFromSource(whole, MCP_PAGE), whole)

  // Not present in the source verbatim — a paraphrase or a hallucination — is
  // returned as-is rather than being "repaired" from unrelated text.
  assert.equal(completeQuoteFromSource('{ "mcpServers": { "vfb": {', MCP_PAGE), '{ "mcpServers": { "vfb": {')

  // Nothing to work with.
  assert.equal(completeQuoteFromSource('', MCP_PAGE), '')
  assert.equal(completeQuoteFromSource('{ "a":', ''), '{ "a":')

  // Prose with an unmatched brace that never closes in the source: no repair.
  assert.equal(completeQuoteFromSource('Add this to your client configuration:\n\n{', 'Add this to your client configuration:\n\n{ and nothing more'), 'Add this to your client configuration:\n\n{')
})

test('completeQuoteFromSource: braces inside strings are not counted', () => {
  // A closing brace inside a JSON string value must not look like the one that
  // balances the block, or the repair stops early and still hands over broken
  // JSON — the exact failure it exists to prevent.
  const src = '{\n"note": "use } carefully",\n"url": "x"\n}\ntrailing prose'
  const clipped = '{\n"note": "use } carefully",\n"url": "x"\n'
  const fixed = completeQuoteFromSource(clipped, src)
  assert.equal(fixed, '{\n"note": "use } carefully",\n"url": "x"\n}')
  assert.doesNotThrow(() => JSON.parse(fixed))
})

test('completeQuoteFromSource: does not swallow the rest of the page', () => {
  // A bounded repair. If closing the quote would mean dragging in hundreds of
  // characters of unrelated page, the honest output is the model's own quote.
  const src = '{\n"a": 1,\n' + 'x'.repeat(900) + '\n}'
  const clipped = '{\n"a": 1,\n'
  assert.equal(completeQuoteFromSource(clipped, src), clipped)
})

test('buildEvidenceRow: source-tagged with locator; rejects bad source', () => {
  const row = buildEvidenceRow({ source: 'literature', claim: 'PPL1 → aversive memory', verbatim: '...', locator: { pmid: '20637624', citation: 'Aso 2010' } })
  assert.equal(row.source, 'literature')
  assert.equal(row.pmid, '20637624')
  assert.throws(() => buildEvidenceRow({ source: 'web', claim: 'x' }))
})

test('needsDocumentation: how-to/platform yes, anatomy fact no', () => {
  assert.equal(needsDocumentation('How do I download VFB images?'), true)
  assert.equal(needsDocumentation('what is a split-GAL4 line'), true)
  assert.equal(needsDocumentation('What neurotransmitter do Kenyon cells use?'), false)
})

test('needsLiterature: function/evidence yes; refs+detail yes; plain lookup no', () => {
  assert.equal(needsLiterature('What is the function of PPL1?'), true)
  assert.equal(needsLiterature('what is its role in memory'), true)
  assert.equal(needsLiterature('tell me more detail', true), true)
  assert.equal(needsLiterature('what is the mushroom body', false), false)
})

test('planRetrieval: VFB answered + no external ask → skip (escalation only)', () => {
  const r = planRetrieval({ question: 'What is the function of PPL1?', vfbAnswered: true, vfbHasData: true })
  assert.deepEqual(r, { documentation: false, literature: false, reasons: ['vfb-sufficient'] })
})

test('planRetrieval: function question WITH VFB data → no literature (VFB-first)', () => {
  // VFB term-info Description usually answers function; do not escalate to papers.
  const r = planRetrieval({ question: 'What is the function of PPL1?', vfbAnswered: true, vfbHasData: true, hasRefs: true })
  assert.equal(r.literature, false)
  assert.equal(r.documentation, false)
})

test('planRetrieval: function question with NO usable VFB data → literature last resort', () => {
  const r = planRetrieval({ question: 'What is the function of PPL1?', vfbAnswered: false, vfbHasData: false, hasRefs: true })
  assert.equal(r.literature, true)
  assert.ok(r.reasons.includes('vfb-empty-fallback'))
})

test('planRetrieval: explicit "more detail" with VFB data → literature', () => {
  const r = planRetrieval({ question: 'tell me more detail about PPL1 function', vfbAnswered: true, vfbHasData: true })
  assert.equal(r.literature, true)
  assert.ok(r.reasons.includes('wants-more-detail'))
})

test('planRetrieval: how-to question → documentation', () => {
  const r = planRetrieval({ question: 'How do I download VFB images?', vfbAnswered: false })
  assert.equal(r.documentation, true)
})

test('planRetrieval: the planner\'s own documentation intent counts, not just the phrasing', () => {
  // "How do I use the Virtual Fly Brain MCP tool?" was PLANNED as documentation
  // and then had documentation retrieval decided against it by a regex that had
  // never heard of MCP. The planner read the question; the regex pattern-matches.
  const r = planRetrieval({ question: 'Tell me about the MCP endpoint', intent: 'documentation', vfbAnswered: true, vfbHasData: true })
  assert.equal(r.documentation, true)
  assert.ok(r.reasons.includes('doc-intent'))
})

test('needsDocumentation: questions about VFB ITSELF reach the docs', () => {
  // Each of these has a documentation answer and no ontology answer at all, so
  // missing the route does not degrade the answer — it removes it.
  for (const q of [
    'What was included in the latest Virtual Fly Brain release?',
    'How should I cite Virtual Fly Brain in a publication?',
    'Who funds Virtual Fly Brain and since when?',
    'What is Virtual Fly Brain and who is it for?',
    'What do confidence values mean on Virtual Fly Brain?',
    'What are bridging registrations between brain templates in VFB?',
    'Where can I access the FAFB or FANC CATMAID datasets via Virtual Fly Brain?',
    'Is there a circuit diagram of the mushroom body available on Virtual Fly Brain?'
  ]) assert.equal(needsDocumentation(q), true, q)
})

test('needsDocumentation: "release" in its synaptic sense is not a docs question', () => {
  // The release/version alternatives are qualified for exactly this reason.
  assert.equal(needsDocumentation('What triggers neurotransmitter release at this synapse?'), false)
  assert.equal(needsDocumentation('Which neurons release dopamine in the mushroom body?'), false)
})

test('planRetrieval: explicit paper request always escalates literature', () => {
  const r = planRetrieval({ question: 'show me the papers on this', vfbAnswered: true, vfbHasData: true })
  assert.equal(r.literature, true)
  assert.ok(r.reasons.includes('explicit-literature'))
})

test('planRetrieval: VFB empty → literature fallback (do not dead-stop)', () => {
  const r = planRetrieval({ question: 'What connects to the antennal lobe?', vfbAnswered: false, vfbHasData: false })
  assert.equal(r.literature, true)
  assert.ok(r.reasons.includes('vfb-empty-fallback'))
})

// ---- hasCopyableBlock: which pages get told to reproduce a block ----
//
// The battery caught the cost of getting this wrong in the permissive
// direction: a support email address, a list of API section headings and a
// plain English sentence all came back inside code fences, because the
// instruction to reproduce a block verbatim was attached to every documentation
// answer rather than to the pages that actually carry one.

test('hasCopyableBlock: true for something the reader is meant to copy', () => {
  assert.equal(hasCopyableBlock('{\n"mcpServers": {\n"virtual-fly-brain": {}\n}\n}'), true)
  assert.equal(hasCopyableBlock('Install it via PyPi:\npip install vfb-connect'), true)
  assert.equal(hasCopyableBlock("n = navis.example_neurons(1, kind='skeleton')"), true)
  assert.equal(hasCopyableBlock('from vfb_connect import VfbConnect'), true)
  assert.equal(hasCopyableBlock('```json\n{"a":1}\n```'), true)
})

test('hasCopyableBlock: false for the prose that was being fenced', () => {
  // Every one of these came back inside a code fence in the D-battery.
  assert.equal(hasCopyableBlock('Public Support Forum: support@virtualflybrain.org'), false)
  assert.equal(hasCopyableBlock('GitHub Issues: Report an issue'), false)
  assert.equal(hasCopyableBlock('Knowledgebase Operations\nDL Queries\nSPARQL Services'), false)
  assert.equal(hasCopyableBlock('Point and click to select neurons/expression\nClick and drag with the mouse to rotate'), false)
  assert.equal(hasCopyableBlock('Below you can watch the recorded introduction session of our workshop and follow along with the workshop notebooks.'), false)
  assert.equal(hasCopyableBlock(''), false)
  assert.equal(hasCopyableBlock('   '), false)
})

// ---- firstCopyableBlock: the part of a how-to answer that cannot be paraphrased ----

test('firstCopyableBlock: takes a fenced block from the page', () => {
  const page = 'Quick start\n\nUse the hosted service.\n\n```json\n{\n  "mcpServers": {\n    "virtual-fly-brain": {\n      "type": "http",\n      "url": "https://vfb3-mcp.virtualflybrain.org"\n    }\n  }\n}\n```\n\nThat is all.'
  const block = firstCopyableBlock(page)
  assert.match(block, /^\{/)
  assert.match(block, /"mcpServers"/)
  assert.match(block, /\}$/)
  assert.ok(!block.includes('```'), 'the fences belong to the page, not the block')
})

test('firstCopyableBlock: reads the page in its serialised form', () => {
  // The page arrives as tool output, so its newlines are the two characters
  // backslash-n — the form every real call passes in.
  const page = 'Configure it:\\n\\n{\\n  "mcpServers": {\\n    "vfb": {}\\n  }\\n}\\n\\nDone.'
  const block = firstCopyableBlock(page)
  assert.match(block, /"mcpServers"/)
  assert.match(block, /\n/, 'decoded to real newlines')
})

test('firstCopyableBlock: nothing from a page of prose', () => {
  assert.equal(firstCopyableBlock('Point and click to select neurons. Click and drag to rotate the scene.'), '')
  // A brace in a sentence is not a configuration: one line, and no quoted key.
  assert.equal(firstCopyableBlock('The set {a, b, c} is written in braces.'), '')
  // Multi-line braces with no quoted key are prose too.
  assert.equal(firstCopyableBlock('A list follows {\nfirst\nsecond\n}'), '')
  assert.equal(firstCopyableBlock(''), '')
})

test('firstCopyableBlock: an unterminated or oversized block is left alone', () => {
  assert.equal(firstCopyableBlock('{\n  "mcpServers": {\n    "vfb": {}'), '', 'never closes')
  const huge = '{\n  "k": "' + 'x'.repeat(1400) + '"\n}'
  assert.equal(firstCopyableBlock(huge), '', 'past the size cap')
})
