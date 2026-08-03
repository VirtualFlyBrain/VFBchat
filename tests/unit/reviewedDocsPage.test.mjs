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
