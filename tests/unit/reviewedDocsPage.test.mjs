// Offline unit tests for reviewed-page content extraction.
// Run: node --test tests/unit/reviewedDocsPage.test.mjs
//
// The extractor read <h1>-<h3> and <p> and nothing else, so every page whose
// answer is a command or a config snippet lost exactly the part that answered.
// "How do I install vfb-connect in Python?" came back as "It can be installed
// via PyPi" and no command, because `pip install vfb-connect` sits in a <pre>.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractContentBlocks } from '../../lib/reviewedDocsSearch.js'

// Shaped like the real vfb-connect docs page: a sentence ending in a colon,
// the command it introduces, and a navigation sidebar around both.
const PAGE = `
<html><body>
<nav><ul><li><a href="/a">API Reference</a></li><li><a href="/b">Quickstart Guide</a></li></ul></nav>
<h1>VFB_connect - A library for querying VFB</h1>
<p>VFB_connect is a Python library that wraps open VFB API endpoints, providing canned queries and standard output formats. It can be installed via PyPi:</p>
<div class="highlight"><pre><span class="go">pip install vfb-connect</span></pre></div>
<p class="caption">Fig 1</p>
<h2>Licence</h2>
<p>VFB_connect is licensed under GNU GPLv3 and the source code is hosted on GitHub.</p>
</body></html>
`

// Shaped like the real /about/contactus page: the answer is three short <p>,
// each a label and a link.
const CONTACT = `
<h2>Bug Reports &amp; Feature Requests</h2>
<p>To report technical issues, bugs, or request new features:</p>
<p><strong>GitHub Issues:</strong> <a href="https://github.com/VirtualFlyBrain/VFB2/issues/new/choose">Report an issue</a></p>
<p><strong>Private Email:</strong> <a href="mailto:data@virtualflybrain.org">data@virtualflybrain.org</a></p>
<p><strong>Guidelines:</strong> <a href="https://www.virtualflybrain.org/docs/contribution-guidelines/">Contribution Guidelines</a></p>
<p>Read <a href="#top">more</a> above.</p>
`

test('a code block is kept, and kept next to the sentence that introduces it', () => {
  const blocks = extractContentBlocks(PAGE)
  const intro = blocks.findIndex(b => b.includes('installed via PyPi'))
  const command = blocks.indexOf('pip install vfb-connect')

  assert.ok(intro >= 0, 'the introducing sentence should survive')
  assert.ok(command >= 0, 'the command should survive')
  assert.equal(command, intro + 1, `command should follow its sentence: ${JSON.stringify(blocks)}`)
})

test('navigation list items stay out', () => {
  // <li> looks like content and is overwhelmingly menu links — pages on the
  // site carry 500-1300 of them each.
  const blocks = extractContentBlocks(PAGE)
  assert.ok(!blocks.some(b => b.includes('API Reference')), blocks.join(' | '))
})

test('short prose is dropped but short code is not', () => {
  // A caption is noise at 5 characters; `pip install x` is the whole answer at 23.
  const blocks = extractContentBlocks(PAGE)
  assert.ok(!blocks.includes('Fig 1'))
  assert.ok(blocks.includes('pip install vfb-connect'))
})

test('the page title is not repeated as a content block', () => {
  const blocks = extractContentBlocks(PAGE, { skip: 'VFB_connect - A library for querying VFB' })
  assert.ok(!blocks.includes('VFB_connect - A library for querying VFB'))
  assert.equal(blocks[0].slice(0, 12), 'VFB_connect ')
})

test('blocks come back in document order, not tag-type order', () => {
  // The old extractor emitted every heading first and then every paragraph,
  // which put "Licence" ahead of the install instructions.
  const blocks = extractContentBlocks(PAGE)
  assert.ok(blocks.indexOf('Licence') > blocks.indexOf('pip install vfb-connect'))
})

test('a short block survives if it carries a link', () => {
  // "How do I report a problem or contribute data?" was answered with the
  // page's feedback widget, because the three <p> that actually answered were
  // all under 40 characters and were dropped for being short.
  const blocks = extractContentBlocks(CONTACT)
  assert.ok(blocks.some(b => b.startsWith('GitHub Issues:')), blocks.join(' | '))
  assert.ok(blocks.some(b => b.includes('data@virtualflybrain.org')), blocks.join(' | '))
})

test('an allowed link target is inlined; an off-allow-list one is not', () => {
  // The output sanitiser rewrites any off-allow-list URL to "[External link
  // removed]", so offering the model the GitHub address produced "submit an
  // issue on GitHub at [External link removed]".
  const blocks = extractContentBlocks(CONTACT).join('\n')
  assert.ok(blocks.includes('Contribution Guidelines (https://www.virtualflybrain.org/docs/contribution-guidelines/)'), blocks)
  assert.ok(!blocks.includes('github.com'), blocks)
  assert.ok(blocks.includes('Report an issue'), blocks)
})

test('an in-page anchor adds nothing and is not inlined', () => {
  const blocks = extractContentBlocks(CONTACT).join('\n')
  assert.ok(!blocks.includes('more (#top)'), blocks)
})

test('a mailto link is not repeated when its text is already the address', () => {
  const blocks = extractContentBlocks(CONTACT)
  const email = blocks.find(b => b.includes('data@virtualflybrain.org'))
  assert.equal(email, 'Private Email: data@virtualflybrain.org')
})

test('an empty or tagless page is an empty list, not a throw', () => {
  assert.deepEqual(extractContentBlocks(''), [])
  assert.deepEqual(extractContentBlocks('<div>no blocks here</div>'), [])
})

// Shaped like the real /docs/data/em/ page, which is a Hugo Docsy page: the
// site menu lives in <nav> and <aside> OUTSIDE <main>, and the answer to "where
// can I access the FAFB or FANC CATMAID datasets?" lives entirely inside a
// comparison table and a bulleted list. Both were dropped by the extractor, so
// the words FAFB and FANC appeared nowhere in what the index or the model saw.
const DOCSY = `
<html><body>
<header><nav class="td-navbar"><ul><li><a href="/docs/">Documentation</a></li></ul></nav></header>
<main class="td-main" role="main">
  <aside class="td-sidebar"><nav class="td-sidebar-nav"><ul><li><a href="/docs/apis/">API Reference</a></li></ul></nav></aside>
  <h1>Electron Microscopy Data</h1>
  <p>Virtual Fly Brain integrates several electron microscopy connectomics datasets, listed below.</p>
  <h2>Datasets Hosted by VFB</h2>
  <ul>
    <li>FAFB (Full Adult Fly Brain) — served from a CATMAID instance hosted by VFB.</li>
    <li>FANC (Female Adult Nerve Cord) — served from a CATMAID instance hosted by VFB.</li>
  </ul>
  <h2>Comparison Table of Integrated Datasets</h2>
  <table>
    <tr><th>Dataset</th><th>Scope</th><th>Browser</th></tr>
    <tr><td>FAFB (FlyWire)</td><td>Full brain (adult female)</td><td>Codex</td></tr>
    <tr><td>FANC</td><td>Full VNS (adult female)</td><td>CATMAID</td></tr>
  </table>
</main>
<footer><nav><ul><li><a href="/about/">About us</a></li></ul></nav></footer>
</body></html>
`

test('a table is read a row at a time, cells joined', () => {
  // On the real page the words FAFB and FANC appear ONLY inside this table and
  // the list above it. Dropping <td> made the question unanswerable while the
  // answer sat on an indexed page.
  const blocks = extractContentBlocks(DOCSY)
  assert.ok(blocks.includes('FANC | Full VNS (adult female) | CATMAID'), blocks.join(' | '))
  assert.ok(blocks.includes('Dataset | Scope | Browser'), blocks.join(' | '))
})

test('list items are read inside an isolated main region', () => {
  // <li> was excluded outright because a docs page carries 400-1300 of them and
  // nearly all are menu links — but that is a statement about the sidebar, not
  // about lists. Once the sidebar is gone, the remaining list is the content.
  const blocks = extractContentBlocks(DOCSY)
  assert.ok(blocks.some(b => b.startsWith('FAFB (Full Adult Fly Brain)')), blocks.join(' | '))
})

test('chrome is stripped even when it is nested inside main', () => {
  // The Docsy sidebar is <aside> wrapping <nav> wrapping the menu, and it sits
  // INSIDE <main>. A non-greedy match closes on the first end tag, which would
  // leave half the menu behind.
  const blocks = extractContentBlocks(DOCSY).join(' | ')
  assert.ok(!blocks.includes('API Reference'), blocks)
  assert.ok(!blocks.includes('About us'), blocks)
  assert.ok(!blocks.includes('Documentation'), blocks)
})

test('list items stay out when the page marks no main region', () => {
  // Without a main marker there is nothing separating menu from content, so the
  // old conservative rule still applies. PAGE has a bare <nav> and no <main>.
  const blocks = extractContentBlocks(PAGE)
  assert.ok(!blocks.some(b => b.includes('Quickstart Guide')), blocks.join(' | '))
})

test('role="main" counts as a main region, not just <main>', () => {
  // readthedocs marks its article with <div role="main"> and has no <main>
  // element at all; vfb-connect is a third of the reviewed corpus.
  const rtd = `
    <body>
      <nav class="wy-nav-side"><ul><li><a href="/x">Menu entry</a></li></ul></nav>
      <div role="main"><h1>Tutorials</h1><ul><li>Query VFB for neurons in a region of interest.</li></ul></div>
    </body>`
  const blocks = extractContentBlocks(rtd)
  assert.ok(blocks.some(b => b.startsWith('Query VFB for neurons')), blocks.join(' | '))
  assert.ok(!blocks.some(b => b.includes('Menu entry')), blocks.join(' | '))
})
