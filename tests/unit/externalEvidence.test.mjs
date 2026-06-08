// Offline unit tests for the external-evidence retriever roles (pure logic).
// Run: node --test tests/unit/externalEvidence.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPublicationRefs, hasPublicationRefs, bestRefUrl } from '../../lib/literatureRefs.mjs'
import {
  EXTRACT_SCHEMA, buildDocExtractMessages, buildLiteratureExtractMessages,
  buildEvidenceRow, needsDocumentation, needsLiterature, planRetrieval
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
})

test('buildLiteratureExtractMessages: cites the ref', () => {
  const m = buildLiteratureExtractMessages({ question: 'role in memory?', content: 'PPL1 mediates aversive memory.', ref: { citation: 'Aso 2010', pmid: '20637624' } })
  assert.match(m[1].content, /Aso 2010/)
  assert.match(m[1].content, /role in memory\?/)
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
