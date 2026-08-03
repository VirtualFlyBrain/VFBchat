// A rewrite rule that substitutes a whole sentence must only fire where a
// sentence starts. The regression these tests pin is an answer that read
// "…it is not possible to determine if This bounded VFB pass did not confirm…":
// a capitalised standalone sentence spliced into the middle of a hedge, because
// the rule matched the same words as a subordinate clause.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sentenceStart } from '../../lib/sentenceRewrite.mjs'

const CLAIM = '(?:The Hemibrain dataset contains neurons that are|There are neurons in the Hemibrain dataset that are) morphologically similar to the fru\\+ mAL neurons described in light microscopy studies\\.[ \\t]*'
const REPLACEMENT = '$1This bounded VFB pass did not confirm Hemibrain neurons morphologically similar to the fru+ mAL neurons. '

const rewrite = s => String(s).replace(sentenceStart(CLAIM), REPLACEMENT)

test('the affirmative claim is still replaced when it opens the string', () => {
  const out = rewrite('The Hemibrain dataset contains neurons that are morphologically similar to the fru+ mAL neurons described in light microscopy studies. Two candidates are listed below.')
  assert.equal(out, 'This bounded VFB pass did not confirm Hemibrain neurons morphologically similar to the fru+ mAL neurons. Two candidates are listed below.')
})

test('and when it follows another sentence, without eating the full stop', () => {
  const out = rewrite('VFB was checked. There are neurons in the Hemibrain dataset that are morphologically similar to the fru+ mAL neurons described in light microscopy studies. Done.')
  assert.equal(out, 'VFB was checked. This bounded VFB pass did not confirm Hemibrain neurons morphologically similar to the fru+ mAL neurons. Done.')
})

test('and at the start of a line in a bulleted answer', () => {
  const out = rewrite('Findings:\nThe Hemibrain dataset contains neurons that are morphologically similar to the fru+ mAL neurons described in light microscopy studies.')
  assert.equal(out, 'Findings:\nThis bounded VFB pass did not confirm Hemibrain neurons morphologically similar to the fru+ mAL neurons. ')
})

test('the same words inside a hedge are left exactly alone', () => {
  // The sentence already says the thing is unconfirmed. There is no false claim
  // to suppress, and substituting one here is what produced the garbled T2.7
  // answer: "…it is not possible to determine if This bounded VFB pass did…".
  const hedge = 'Without a matched term, it is not possible to determine if the Hemibrain dataset contains neurons that are morphologically similar to the fru+ mAL neurons described in light microscopy studies.'
  assert.equal(rewrite(hedge), hedge)
})

test('a capitalised mid-sentence occurrence is left alone too', () => {
  const mid = 'It is unclear whether The Hemibrain dataset contains neurons that are morphologically similar to the fru+ mAL neurons described in light microscopy studies.'
  assert.equal(rewrite(mid), mid)
})

test('a sentence ending in a quote or bracket still counts as a boundary', () => {
  for (const close of ['"', "'", ')', ']']) {
    const out = rewrite(`VFB returned nothing.${close} The Hemibrain dataset contains neurons that are morphologically similar to the fru+ mAL neurons described in light microscopy studies.`)
    assert.equal(out, `VFB returned nothing.${close} This bounded VFB pass did not confirm Hemibrain neurons morphologically similar to the fru+ mAL neurons. `)
  }
})

test('the boundary is handed back, so two sentences are never joined', () => {
  // A rule that consumed the preceding "." would leave "…checked This bounded…".
  const out = rewrite('VFB was checked. The Hemibrain dataset contains neurons that are morphologically similar to the fru+ mAL neurons described in light microscopy studies.')
  assert.match(out, /checked\. This bounded/)
})

test('sentenceStart is case-sensitive unless asked otherwise', () => {
  assert.equal('x. the claim.'.replace(sentenceStart('the claim\\.'), '$1REPLACED'), 'x. REPLACED')
  assert.equal('x. The claim.'.replace(sentenceStart('the claim\\.'), '$1REPLACED'), 'x. The claim.')
  assert.equal('x. The claim.'.replace(sentenceStart('the claim\\.', 'gi'), '$1REPLACED'), 'x. REPLACED')
})
