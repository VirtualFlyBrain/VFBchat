// Probe the two roles a straight swap would put at risk:
//   extract — callStructured with useGuidedJson:true (vLLM guided decode)
//   synth   — the streaming path route.js actually reads (delta.content only)
import fs from 'node:fs'
import { callStructured } from '../lib/elmClient.mjs'

const KEY = fs.readFileSync('/tmp/.elmenv', 'utf8')
  .split('\n').find(l => l.startsWith('ELM_API_KEY=')).split('=')[1].trim()
const BASE = 'https://elm.edina.ac.uk/api/v1'
const TOOLS = JSON.parse(fs.readFileSync('/tmp/tooldefs.json', 'utf8'))
const MODELS = process.argv.slice(2)

const tool = TOOLS.find(t => t.name === 'vfb_find_connectivity_partners')
const schema = tool.parameters

const EXTRACT_MSGS = [
  { role: 'system', content: 'Produce the arguments for the next tool call as JSON matching the schema. JSON only.' },
  { role: 'user', content: 'QUESTION: Which dopaminergic neurons provide input to mushroom body output neurons?\nTOOL: vfb_find_connectivity_partners\nSCHEMA:\n' + JSON.stringify(schema) + '\nReturn the arguments object as JSON.' }
]

console.log('=== extract role: useGuidedJson:true, 4 runs each ===')
for (const model of MODELS) {
  for (let i = 0; i < 4; i++) {
    const t = Date.now()
    const r = await callStructured({
      baseUrl: BASE, apiKey: KEY, model, messages: EXTRACT_MSGS,
      schema, schemaName: 'vfb_find_connectivity_partners_args',
      useGuidedJson: true, temperature: 0, timeoutMs: 240000
    })
    console.log(`${model.split('/').pop().slice(0, 18).padEnd(18)} run${i} ok=${r.ok} att=${r.attempts} ${((Date.now() - t) / 1000).toFixed(1)}s ${r.ok ? JSON.stringify(r.value).slice(0, 150) : r.error}`)
  }
}

console.log('\n=== synth role: streaming, what the SSE chunks actually carry ===')
for (const model of MODELS) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Answer from the evidence only. Two sentences.' },
        { role: 'user', content: 'EVIDENCE: Kenyon cell downstream partners ranked by mean synapses per connected pair: mushroom body output neuron 7.09; mushroom body modulatory input neuron 1.96.\n\nQUESTION: What are the main synaptic partners of Kenyon cells?' }
      ],
      stream: true
    })
  })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', firstReasoning = null, firstContent = null, content = '', reasoning = '', keys = new Set()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
      let obj; try { obj = JSON.parse(line.slice(6)) } catch { continue }
      const d = obj?.choices?.[0]?.delta
      if (!d) continue
      for (const k of Object.keys(d)) keys.add(k)
      if (d.reasoning_content) { firstReasoning ??= Date.now() - t0; reasoning += d.reasoning_content }
      if (d.content) { firstContent ??= Date.now() - t0; content += d.content }
    }
  }
  console.log(`${model.split('/').pop().slice(0, 18).padEnd(18)} delta keys seen: ${[...keys].join(',')}`)
  console.log(`   first reasoning token: ${firstReasoning ?? '-'}ms | first CONTENT token: ${firstContent ?? '-'}ms | total ${Date.now() - t0}ms`)
  console.log(`   reasoning chars: ${reasoning.length} | answer chars: ${content.length}`)
  console.log(`   answer: ${content.replace(/\n/g, ' ').slice(0, 180)}`)
}
