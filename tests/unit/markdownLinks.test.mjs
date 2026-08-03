// Markdown-link parsing, macro-tool evidence and the answer linkifiers.
//
// Every fixture label here is real: VFB expression-pattern labels carry the
// transgene's own square brackets, which is precisely the case the codebase's
// `[^\]]+` patterns could not span.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  matchMarkdownLinkAt, stripMarkdownLinks, splitMarkdownCell, splitProtectedSpans
} from '../../lib/markdownLinks.mjs'
import { summariseMacroToolRows } from '../../lib/orchestrator.mjs'
import { linkifyCounts, linkifyKnownTerms } from '../../lib/followOns.mjs'
import { createLedger, recordTermId } from '../../lib/ledger.mjs'

const NESTED = '[PBac{602.P.SVS-1}Fas2[CPTI000483] expression pattern](VFBexp_FBti0144014)'
const NESTED_NAME = 'PBac{602.P.SVS-1}Fas2[CPTI000483] expression pattern'

// ---------------------------------------------------------------- parsing ---

test('a label carrying its own brackets parses to the whole label', () => {
  const { text, target } = splitMarkdownCell(NESTED)
  assert.equal(text, NESTED_NAME)
  assert.equal(target, 'VFBexp_FBti0144014')
})

test('an ordinary cell still parses', () => {
  const { text, target } = splitMarkdownCell('[APL_R (FlyEM-HB:425790257)](VFB_jrchjrhd)')
  assert.equal(text, 'APL_R (FlyEM-HB:425790257)')
  assert.equal(target, 'VFB_jrchjrhd')
})

test('plain text is returned unchanged with no target', () => {
  assert.deepEqual(splitMarkdownCell('Kenyon cell'), { text: 'Kenyon cell', target: '' })
})

test('a cell that is a link plus trailing prose is not treated as a link', () => {
  // Anchoring matters: taking the link half would silently drop the rest.
  assert.deepEqual(splitMarkdownCell('[a](x) and more'), { text: '[a](x) and more', target: '' })
})

test('an unbalanced bracket leaves the text alone rather than half-parsing it', () => {
  assert.equal(matchMarkdownLinkAt('[Fas2[CPTI000483 pattern](VFBexp_1)', 0), null)
  assert.equal(stripMarkdownLinks('Fas2[CPTI000483 alone'), 'Fas2[CPTI000483 alone')
})

test('stripping several links in one string does not run them together', () => {
  // The tempting greedy fix ("\[(.+)\]\(") would make this one link from [a to b].
  assert.equal(stripMarkdownLinks('[a](x) then [b](y)'), 'a then b')
})

test('stripping keeps a nested-bracket label intact', () => {
  assert.equal(stripMarkdownLinks(`see ${NESTED} today`), `see ${NESTED_NAME} today`)
})

test('splitProtectedSpans puts links, code and URLs at odd indices', () => {
  const parts = splitProtectedSpans(`start ${NESTED} mid \`code\` end https://x.test/1 tail`)
  assert.equal(parts.length % 2, 1, 'must start and end with a plain segment')
  assert.deepEqual(parts.filter((_, i) => i % 2 === 1), [NESTED, '`code`', 'https://x.test/1'])
  assert.equal(parts.join(''), `start ${NESTED} mid \`code\` end https://x.test/1 tail`)
})

// ------------------------------------------------------- macro evidence ---

const GENETIC_TOOLS = {
  query: 'genetic tools for mushroom body',
  focus_term: { id: 'FBbt_00005801', label: 'mushroom body' },
  evidence_summary: { answer_hint: 'VFB returned 3996 genetic tool rows for mushroom body' },
  query_counts: { TransgeneExpressionHere: 4130 },
  top_tools: [
    { id: 'VFBexp_FBti0144014', name: NESTED },
    { id: 'VFBexp_FBti0144061', name: '[PBac{602.P.SVS-1}HDAC4[CPTI000077] expression pattern](VFBexp_FBti0144061)' }
  ],
  next_actions: [
    { label: 'Check expression specificity' },
    { label: 'Compare with FlyLight' },
    { label: 'Open in VFB' }
  ],
  warnings: []
}

test('a macro payload yields a claim naming what the tool returned', () => {
  const out = summariseMacroToolRows(GENETIC_TOOLS, { tool: 'vfb_find_genetic_tools' })
  assert.equal(out.key, 'top_tools')
  assert.equal(out.rows.length, 2)
  assert.equal(out.rows[0].name, NESTED_NAME, 'the markdown must be stripped before it becomes a name')
  assert.equal(out.rows[0].id, 'VFBexp_FBti0144014')
  assert.match(out.claim, /a selection, not a complete list/)
  assert.match(out.claim, /Fas2\[CPTI000483\] expression pattern \(VFBexp_FBti0144014\)/)
})

test('the claim states no count — a figure supplied is a figure reported', () => {
  // The array length is the tool's page size, not a total. Handed one, the
  // synthesiser printed "VFB holds 12 records" above a table reporting 4130.
  const { claim } = summariseMacroToolRows(GENETIC_TOOLS, { tool: 'vfb_find_genetic_tools' })
  const preamble = claim.slice(0, claim.indexOf('PBac'))
  assert.ok(!/\d/.test(preamble), preamble)
})

test('the claim leaks neither the tool name nor the payload key into prose', () => {
  const { claim } = summariseMacroToolRows(GENETIC_TOOLS, { tool: 'vfb_find_genetic_tools' })
  assert.ok(!/genetic tools/i.test(claim), claim)
  assert.ok(!/top.tools/i.test(claim), claim)
})

test('next_actions is never mistaken for evidence', () => {
  // It has more entries than top_tools here, and its entries have a `label`, so a
  // plain "largest named array" pick would report "Check expression specificity"
  // as though it were a GAL4 line.
  const out = summariseMacroToolRows(GENETIC_TOOLS, { tool: 'vfb_find_genetic_tools' })
  assert.equal(out.key, 'top_tools')
  assert.ok(!JSON.stringify(out.rows).includes('Check expression specificity'))
})

test('a run_query payload is left to its own branch', () => {
  assert.equal(summariseMacroToolRows({ rows: [{ label: 'x' }], count: 1 }), null)
})

test('a payload that names nothing returns null so the caller can fall through', () => {
  assert.equal(summariseMacroToolRows({ query_counts: { A: 3 }, warnings: ['slow'] }), null)
  assert.equal(summariseMacroToolRows(null), null)
  assert.equal(summariseMacroToolRows([{ label: 'x' }]), null)
})

test('a macro row registers under its plain name, so it can be linked', () => {
  const ledger = createLedger('which GAL4 lines label the mushroom body?')
  const { rows } = summariseMacroToolRows(GENETIC_TOOLS, { tool: 'vfb_find_genetic_tools' })
  for (const r of rows) recordTermId(ledger, r.name, r.id)
  assert.equal(ledger.registry[NESTED_NAME.toLowerCase()]?.id, 'VFBexp_FBti0144014')
})

// ----------------------------------------------------------- linkifiers ---

const COUNTS = [
  { count: 4130, url: 'https://v2.test/?q=FBbt_00005801,TransgeneExpressionHere', title: 'Run in VFB', label: 'Expression' },
  { count: 602, url: 'https://v2.test/?q=FBbt_00005801,NeuronsPartHere', title: 'Run in VFB', label: 'Parts' }
]

test('a figure inside a genotype is not linkified', () => {
  const text = `The ${NESTED_NAME} labels it.`
  assert.equal(linkifyCounts(text, COUNTS), text)
})

test('a real count still linkifies, with or without thousands commas', () => {
  assert.match(linkifyCounts('VFB holds 4130 rows.', COUNTS), /\[4130\]\(https:\/\/v2\.test/)
  assert.match(linkifyCounts('VFB holds 4,130 rows.', COUNTS), /\[4,130\]\(https:\/\/v2\.test/)
})

test('a figure ending a sentence keeps its full stop outside the link', () => {
  const out = linkifyCounts('The total is 4130.', COUNTS)
  assert.match(out, /\[4130\]\([^)]*\)\.$/)
})

test('a lower bound is left alone — it is the counting cap, not a query total', () => {
  assert.equal(linkifyCounts('more than 4130 images', COUNTS), 'more than 4130 images')
})

test('a figure already inside a link is not linked again', () => {
  const text = '[4130](https://v2.test/existing) rows'
  assert.equal(linkifyCounts(text, COUNTS), text)
})

const TERMS = [{ name: NESTED_NAME, id: 'VFBexp_FBti0144014', url: 'https://vfb.test/VFBexp_FBti0144014' }]

test('a name the model left in bare brackets is linked as the whole span', () => {
  const out = linkifyKnownTerms(`Lines include [${NESTED_NAME}] here.`, TERMS)
  assert.ok(!out.includes(`[${NESTED_NAME}]`) || out.includes('](https://vfb.test/'), out)
  assert.match(out, /^Lines include \[PBac\{602\.P\.SVS-1\}Fas2\[CPTI000483\] expression pattern\]\(https:\/\/vfb\.test\//)
  assert.ok(out.endsWith('here.'), out)
})

test('a plain name is linked too, and only once', () => {
  const out = linkifyKnownTerms(`${NESTED_NAME} and ${NESTED_NAME}`, TERMS)
  assert.equal(out.match(/https:\/\/vfb\.test/g).length, 1)
})

test('an unmatched opening bracket is left alone rather than doubled', () => {
  // "[[name](url)" renders as a stray bracket against a link — worse than the
  // unlinked name, so the bare-name arm refuses a preceding "[".
  const out = linkifyKnownTerms(`[${NESTED_NAME}`, TERMS)
  assert.equal(out, `[${NESTED_NAME}`)
})

test('a name already linked in the prose is left alone', () => {
  const text = `[${NESTED_NAME}](https://vfb.test/VFBexp_FBti0144014) is one.`
  assert.equal(linkifyKnownTerms(text, TERMS), text)
})

// ------------------------------------------------- links inside link titles ---
// Every link this codebase writes carries a hover title built from a VFB label,
// so a label with parentheses puts a ")" inside the target. "What types of Kenyon
// cells exist in the adult Drosophila brain?" answered with a link nested inside
// another link's title, twice in one sentence.

const TITLED = '[KCab-c(i)](https://www.virtualflybrain.org/reports/FBbt_00049111 "Open KCab-c(i) in Virtual Fly Brain")'

test('a link whose title contains parentheses parses to the whole link', () => {
  const m = matchMarkdownLinkAt(TITLED, 0)
  assert.equal(m.text, 'KCab-c(i)')
  assert.equal(m.end, TITLED.length, 'the link ends at its own closing bracket, not inside its title')
  assert.ok(m.target.endsWith('in Virtual Fly Brain"'))
})

test('a quoted title may hold an unbalanced bracket of its own', () => {
  const s = '[x](https://example.org/a "Open x) in Virtual Fly Brain")'
  assert.equal(matchMarkdownLinkAt(s, 0).end, s.length)
})

test('a titled link is protected whole, so nothing linkifies its title', () => {
  const parts = splitProtectedSpans(`before ${TITLED} after`)
  assert.equal(parts[1], TITLED)
  assert.equal(parts[2], ' after')
})

test('a term name is not linked inside the title of a link just written', () => {
  // Names arrive longest-first, so the shorter name is a substring of the longer
  // one's title the moment that title exists.
  const termLinks = [
    { name: 'KCab-c(i)', id: 'FBbt_00049111', url: 'https://www.virtualflybrain.org/reports/FBbt_00049111' },
    { name: 'KCab-c', id: 'FBbt_00110929', url: 'https://www.virtualflybrain.org/reports/FBbt_00110929' }
  ]
  const out = linkifyKnownTerms('There are KCab-c(i) cells in the brain.', termLinks)
  assert.equal(out.match(/\]\(/g).length, 1, 'exactly one link was written')
  assert.ok(!/"Open \[/.test(out), 'no link opens inside a title')
  assert.match(out, /^There are \[KCab-c\(i\)\]\(\S+ "Open KCab-c\(i\) in Virtual Fly Brain"\) cells in the brain\.$/)
})

test('a shorter name still links where it genuinely appears in prose', () => {
  // The fix must not cost the second link — only the one inside the title.
  const termLinks = [
    { name: 'Kenyon cell of main calyx', id: 'FBbt_00047926', url: 'https://www.virtualflybrain.org/reports/FBbt_00047926' },
    { name: 'Kenyon cell', id: 'FBbt_00003686', url: 'https://www.virtualflybrain.org/reports/FBbt_00003686' }
  ]
  const out = linkifyKnownTerms('The Kenyon cell of main calyx is one Kenyon cell type.', termLinks)
  assert.equal(out.match(/\]\(/g).length, 2)
  assert.ok(!/"Open \[/.test(out))
  assert.match(out, /FBbt_00047926/)
  assert.match(out, /is one \[Kenyon cell\]\(https:\/\/www\.virtualflybrain\.org\/reports\/FBbt_00003686/)
})
