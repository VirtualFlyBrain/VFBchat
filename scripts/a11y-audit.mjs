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

const results = []
// The sandbox ships Chromium at a fixed path and blocks the download step, so
// point at it rather than letting Playwright fetch its own.
const executablePath = process.env.A11Y_CHROME ||
  (await import('node:fs')).globSync?.('/opt/pw-browsers/chromium-*/chrome-linux/chrome')?.[0] || undefined
const browser = await chromium.launch(executablePath ? { executablePath } : {})

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })

for (const path of PAGES) {
  const page = await context.newPage()
  let error = null
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 45000 })
    // The chat page renders its shell immediately but settles a moment later.
    await page.waitForTimeout(1200)
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
