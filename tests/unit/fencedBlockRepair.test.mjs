// Offline unit tests for the in-stream fenced-block repair.
// Run: node --test tests/unit/fencedBlockRepair.test.mjs
//
// This filter sits in front of every streamed answer, so the thing to prove is
// not only that it closes a truncated configuration block, but that it is inert
// on everything else — prose, blocks from other sources, blocks that were
// already correct. A filter that mangles a Python snippet to fix a JSON one is
// not worth having.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFenceRepairer } from '../../lib/fencedBlockRepair.mjs'

// The doc evidence the synthesiser was given: the whole block from the page.
const QUOTE = `{
"mcpServers": {
"virtual-fly-brain": {
"type": "http",
"url": "https://vfb3-mcp.virtualflybrain.org",
"tools": ["*"]
}
}
}`

/** Feed `text` through in chunks of `size` and return everything emitted. */
function stream(text, sources, size = 7) {
  const r = createFenceRepairer(sources)
  let out = ''
  for (let i = 0; i < text.length; i += size) out += r.push(text.slice(i, i + size))
  return out + r.flush()
}

test('the truncated configuration block is closed from the page quote', () => {
  // Exactly what the synthesiser produced on two runs in five: re-indented, and
  // one closing brace short.
  const answer = 'Use this configuration:\n```\n{\n"mcpServers": {\n  "virtual-fly-brain": {\n    "type": "http",\n    "url": "https://vfb3-mcp.virtualflybrain.org",\n    "tools": ["*"]\n  }\n}\n```\nThat connects the client.'
  const out = stream(answer, [QUOTE])
  const block = out.split('```')[1].replace(/^[a-z]*\n/, '')
  assert.doesNotThrow(() => JSON.parse(block), block)
  assert.equal(JSON.parse(block).mcpServers['virtual-fly-brain'].url, 'https://vfb3-mcp.virtualflybrain.org')
  // The prose either side is untouched, and the fences survive.
  assert.ok(out.startsWith('Use this configuration:\n```\n'), out)
  assert.ok(out.endsWith('```\nThat connects the client.'), out)
})

test('a block that is already complete is passed through byte for byte', () => {
  const answer = 'Use this:\n```json\n' + QUOTE + '\n```\nDone.'
  assert.equal(stream(answer, [QUOTE]), answer)
})

test('a block from somewhere else is never touched', () => {
  // No documentation quote contains this, so there is nothing to complete it
  // from — and inventing a brace here would be a new defect, not a fix.
  const answer = 'Then run:\n```python\nvc = VfbConnect(\n```\nand continue.'
  assert.equal(stream(answer, [QUOTE]), answer)
  assert.equal(stream(answer, []), answer)
})

test('chunk boundaries do not change the output', () => {
  const answer = 'Config:\n```\n{\n"mcpServers": {\n"virtual-fly-brain": {\n"type": "http",\n"url": "https://vfb3-mcp.virtualflybrain.org",\n"tools": ["*"]\n}\n}\n```\ndone'
  const whole = stream(answer, [QUOTE], answer.length)
  for (const size of [1, 2, 3, 5, 13, 64]) {
    assert.equal(stream(answer, [QUOTE], size), whole, `chunk size ${size}`)
  }
  assert.doesNotThrow(() => JSON.parse(whole.split('```')[1]))
})

test('prose with backticks streams through untouched', () => {
  // Inline code is not a fence, and a stray backtick must not swallow the rest
  // of the answer waiting for a fence that never comes.
  const answer = 'Point the client at `https://vfb3-mcp.virtualflybrain.org` to connect.'
  assert.equal(stream(answer, [QUOTE]), answer)
  assert.equal(stream('a ``b`` c', [QUOTE]), 'a ``b`` c')
})

test('an answer with no code block at all is unchanged', () => {
  const answer = 'VFB does not currently hold data on that.'
  assert.equal(stream(answer, [QUOTE]), answer)
})

test('two blocks in one answer are handled independently', () => {
  const other = '{\n"servers": {\n"virtual-fly-brain": {\n"type": "http"\n}\n}\n}'
  const answer = 'One:\n```\n{\n"mcpServers": {\n"virtual-fly-brain": {\n"type": "http",\n"url": "https://vfb3-mcp.virtualflybrain.org",\n"tools": ["*"]\n}\n}\n```\nor two:\n```\n' + other + '\n```\n'
  const out = stream(answer, [QUOTE, other])
  const blocks = out.split('```').filter((_, i) => i % 2 === 1)
  assert.equal(blocks.length, 2)
  for (const b of blocks) assert.doesNotThrow(() => JSON.parse(b), b)
})

test('a stream that ends mid-block still releases what it held', () => {
  // Truncation upstream must not mean the reader sees nothing at all.
  const r = createFenceRepairer([QUOTE])
  let out = r.push('Config:\n```\n{\n"mcpServers": {\n')
  out += r.flush()
  assert.ok(out.includes('"mcpServers"'), out)
})

// ---- dropping the synthesiser's own input ----
//
// Two answers in a twenty-one question battery printed plumbing at the reader:
// the evidence record carrying the quote, and the query catalogue the model had
// been handed. Both had already been forbidden in the prompt. A block shaped
// like an internal record is now dropped here instead, where it cannot be
// talked out of.

test('the evidence record is dropped, fences and all', () => {
  const record = '{\n  "claim": "NeuroFly 2026 will be held at the University of Cologne.",\n  "source": "doc",\n  "verbatim": "The 21st Biennial European Drosophila Neurobiology Conference …",\n  "ref": "https://www.virtualflybrain.org/blog/2025/12/17/neurofly-2026"\n}'
  const answer = 'NeuroFly 2026 runs from 7 to 11 September at the University of Cologne.\n\n```json\n' + record + '\n```\n'
  const out = stream(answer, [QUOTE])
  assert.ok(!out.includes('"claim"'), out)
  assert.ok(!out.includes('```'), out)
  assert.ok(out.startsWith('NeuroFly 2026 runs from 7 to 11 September'), out)
})

test('the query catalogue is dropped too', () => {
  const rows = '{\n"tool": "VFB",\n"key": "Queries",\n"rows": [\n{"id": "", "name": "Parts of mushroom body"},\n{"id": "", "name": "Subclasses of mushroom body"}\n]\n}'
  const answer = 'There is a schematic of the mushroom body.\n\n```json\n' + rows + '\n```\n'
  const out = stream(answer, [QUOTE])
  assert.ok(!out.includes('"rows"'), out)
  assert.ok(!out.includes('Subclasses of mushroom body'), out)
  assert.ok(out.startsWith('There is a schematic'), out)
})

test('a record truncated mid-stream is still recognised and dropped', () => {
  const r = createFenceRepairer([QUOTE])
  let out = r.push('Here it is:\n```json\n{"claim": "x", "source": "doc", "verb')
  out += r.flush()
  assert.ok(!out.includes('"claim"'), out)
  assert.ok(!out.includes('```'), out)
})

test('a real configuration is not mistaken for an internal record', () => {
  // The shape test must not fire on the thing this filter exists to protect.
  const answer = 'Use this:\n```json\n' + QUOTE + '\n```\nDone.'
  assert.equal(stream(answer, [QUOTE]), answer)
  // Nor on ordinary JSON that merely mentions a source.
  const data = '{\n"source": "FlyWire",\n"neurons": 12\n}'
  const other = 'Counts:\n```json\n' + data + '\n```\n'
  assert.equal(stream(other, [QUOTE]), other)
})

test('dropping a block does not disturb one that follows it', () => {
  const record = '{"claim": "c", "source": "doc", "ref": "u"}'
  const answer = 'A:\n```json\n' + record + '\n```\nB:\n```json\n' + QUOTE + '\n```\n'
  const out = stream(answer, [QUOTE])
  assert.ok(!out.includes('"claim"'), out)
  const blocks = out.split('```').filter((_, i) => i % 2 === 1)
  assert.equal(blocks.length, 1)
  assert.doesNotThrow(() => JSON.parse(blocks[0].replace(/^json\n/, '')))
})
