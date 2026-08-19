#!/usr/bin/env node
// WCAG 2.2 AA audit of every page VFBchat serves.
//
// VFB Chat is operated by a UK public sector body, so the Public Sector Bodies
// (Websites and Mobile Applications) (No. 2) Accessibility Regulations 2018
// apply, and the /accessibility page makes a public claim about conformance.
// A claim nobody re-tests is a claim that drifts, so this makes the test cheap
// enough to run on every change.
//
// axe-core finds roughly a third to a half of WCAG issues automatically. It is a
// floor, not a certificate: a clean run here means no MACHINE-DETECTABLE
// violation, and the criteria it cannot see — focus order, meaningful sequence,
// error identification, the 2.2 additions around focus appearance and dragging —
// still need a person. The report says so rather than implying a pass.
//
//   node scripts/a11y-audit.mjs                 # against a running server
//   A11Y_BASE=http://127.0.0.1:3210 node scripts/a11y-audit.mjs
//   A11Y_JSON=/tmp/a11y.json node scripts/a11y-audit.mjs

import { chromium } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import fs from 'node:fs'

const BASE = process.env.A11Y_BASE || 'http://127.0.0.1:3210'
const PAGES = ['/', '/privacy', '/accessibility', '/terms']

// WCAG 2.2 AA is 2.0 + 2.1 + 2.2 at levels A and AA. `best-practice` is
// deliberately included but reported separately: it is not a conformance
// requirement and must not be mixed into a compliance number.
const CONFORMANCE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

// ── The answered state ───────────────────────────────────────────────────────
//
// Auditing `/` on load tests an empty shell: a heading, an input and a send
// button. Everything a reader actually spends time in — the answer bubble, the
// result table, the image gallery and its data-derived alt text, the inline
// citations, the response identifier and its copy button, the feedback controls
// — exists only after a question has been answered, and none of it was covered.
// That is also the surface most likely to be wrong, because it is assembled from
// model output rather than written by hand.
//
// The response is STUBBED rather than live, for two reasons. CI has no ELM
// credential on every run, so a real question would skip or fail there and the
// audit would quietly stop covering the answered state. And an accessibility
// check wants a fixed DOM: a live answer varies run to run, so a violation would
// appear and disappear without the interface having changed. The stub is served
// through the real SSE parser and the real renderers, so what axe sees is the
// production DOM — only the words are fixed.
//
// Keep this fixture representative. If a new element type starts appearing in
// answers, add it here or it goes untested.
const ANSWERED_FIXTURE = {
  response: [
    'The **medulla** (FBbt_00003748) is the second optic neuropil of the adult brain.',
    '',
    'It receives input from the lamina and projects to the lobula complex.',
    '',
    'See [Fischbach & Dittrich, 1989](https://doi.org/10.1007/BF00218858) for the classical description.'
  ].join('\n'),
  tables: [{
    title: 'Neurons with synaptic terminals in the medulla',
    rows: [
      { name: 'Tm3 (FlyWire)', thumbnail: 'https://www.virtualflybrain.org/data/VFB/i/0000/0001/thumbnail.png', reportUrl: 'https://www.virtualflybrain.org/reports/VFB_00000001', tags: ['Tm3', 'FlyWire'] },
      { name: 'Mi1 (FlyWire)', thumbnail: 'https://www.virtualflybrain.org/data/VFB/i/0000/0002/thumbnail.png', reportUrl: 'https://www.virtualflybrain.org/reports/VFB_00000002', tags: ['Mi1', 'FlyWire'] }
    ],
    queryUrl: 'https://www.virtualflybrain.org/reports/FBbt_00003748'
  }],
  images: [
    { id: 'VFB_00000001', label: 'Tm3 neuron aligned to JRC2018Unisex', thumbnail: 'https://www.virtualflybrain.org/data/VFB/i/0000/0001/thumbnail.png' }
  ],
  followOns: [
    { kind: 'ask', text: 'Which neurons receive output from the medulla?' },
    { kind: 'vfb', text: 'Open medulla in VFB', url: 'https://www.virtualflybrain.org/reports/FBbt_00003748', title: 'Open in Virtual Fly Brain' }
  ],
  sources: [{ title: 'Fischbach & Dittrich 1989', url: 'https://doi.org/10.1007/BF00218858' }],
  terms: [{ id: 'FBbt_00003748', label: 'medulla' }],
  requestId: 'a11y-audit-request',
  responseId: 'a11y-audit-response'
}

const SSE_FIXTURE =
  `event: status\ndata: ${JSON.stringify({ message: 'Resolving terms' })}\n\n` +
  `event: delta\ndata: ${JSON.stringify({ text: 'The medulla is the second optic neuropil.' })}\n\n` +
  `event: result\ndata: ${JSON.stringify(ANSWERED_FIXTURE)}\n\n`

// Drive the real UI to the answered state: intercept the chat call, type a
// question, send it, and wait for the response identifier — which is rendered
// only once a `result` event has been applied, so it is the honest signal that
// the finished DOM is present.
async function renderAnsweredState(page) {
  await page.route('**/api/chat', route => route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: SSE_FIXTURE
  }))
  // The rate-limit poll fires after a result and is irrelevant here; stub it so
  // a missing backend cannot leave the page in an error state mid-audit.
  await page.route('**/api/rate-info', route => route.fulfill({
    status: 200, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ used: 1, limit: 50, remaining: 49 })
  }))

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 45000 })
  await page.getByPlaceholder('Ask about Drosophila neuroanatomy...').fill('What is the medulla?')
  await page.getByLabel('Send message').click()
  await page.getByText('Response ID:').waitFor({ timeout: 20000 })
  await page.waitForTimeout(400)
}

const results = []
// The sandbox ships Chromium at a fixed path and blocks the download step, so
// point at it rather than letting Playwright fetch its own.
const executablePath = process.env.A11Y_CHROME ||
  (await import('node:fs')).globSync?.('/opt/pw-browsers/chromium-*/chrome-linux/chrome')?.[0] || undefined
const browser = await chromium.launch(executablePath ? { executablePath } : {})

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })

// Each target is a label plus how to get the page into the state being audited.
// The four plain loads are the shell states; the last is the answered state.
const TARGETS = [
  ...PAGES.map(path => ({
    path,
    prepare: async page => {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 45000 })
      // The chat page renders its shell immediately but settles a moment later.
      await page.waitForTimeout(1200)
    }
  })),
  { path: '/ (answered)', prepare: renderAnsweredState }
]

for (const { path, prepare } of TARGETS) {
  const page = await context.newPage()
  let error = null
  try {
    await prepare(page)
  } catch (e) {
    error = e.message
  }

  if (error) {
    results.push({ path, error })
    await page.close()
    continue
  }

  const conformance = await new AxeBuilder({ page }).withTags(CONFORMANCE_TAGS).analyze()
  const practice = await new AxeBuilder({ page }).withTags(['best-practice']).analyze()

  results.push({
    path,
    violations: conformance.violations.map(v => ({
      id: v.id, impact: v.impact, help: v.help, tags: v.tags.filter(t => t.startsWith('wcag')),
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 3).map(n => String(n.target)),
      sample: v.nodes[0]?.html?.slice(0, 160) || ''
    })),
    bestPractice: practice.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
    passes: conformance.passes.length,
    incomplete: conformance.incomplete.map(v => ({ id: v.id, nodes: v.nodes.length }))
  })
  await page.close()
}
await context.close()
await browser.close()

let failures = 0
for (const r of results) {
  if (r.error) { console.log(`\n=== ${r.path} — COULD NOT LOAD: ${r.error}`); failures++; continue }
  const n = r.violations.reduce((a, v) => a + v.nodes, 0)
  failures += n
  console.log(`\n=== ${r.path} — ${r.violations.length} rule(s) violated, ${n} element(s); ${r.passes} rules passed`)
  for (const v of r.violations) {
    console.log(`  [${v.impact}] ${v.id} (${v.tags.join(' ')}) x${v.nodes}`)
    console.log(`      ${v.help}`)
    console.log(`      at ${v.targets.join(' | ')}`)
    if (v.sample) console.log(`      ${v.sample.replace(/\s+/g, ' ')}`)
  }
  if (r.incomplete.length) {
    console.log(`  needs a human: ${r.incomplete.map(i => `${i.id}(${i.nodes})`).join(', ')}`)
  }
  if (r.bestPractice.length) {
    console.log(`  best-practice (not conformance): ${r.bestPractice.map(b => `${b.id}(${b.nodes})`).join(', ')}`)
  }
}

console.log(`\n${'='.repeat(60)}`)
console.log(`WCAG 2.2 AA machine-detectable violations: ${failures}`)
console.log('This is a floor, not a certificate. axe-core sees roughly a third to')
console.log('a half of WCAG issues; focus order, meaningful sequence, error')
console.log('identification and most of the 2.2 additions still need a person.')

if (process.env.A11Y_JSON) {
  fs.writeFileSync(process.env.A11Y_JSON, JSON.stringify(results, null, 1))
  console.log(`\nfull report: ${process.env.A11Y_JSON}`)
}
process.exitCode = failures > 0 ? 1 : 0
