// Synth-role streaming probe, corrected: the vLLM Qwen deployment emits
// delta.reasoning (NOT reasoning_content). Measures time-to-first-VISIBLE-token
// with thinking on vs off, since route.js reads delta.content only.
import fs from 'node:fs'

const KEY = fs.readFileSync('/tmp/.elmenv', 'utf8')
  .split('\n').find(l => l.startsWith('ELM_API_KEY=')).split('=')[1].trim()
const BASE = 'https://elm.edina.ac.uk/api/v1'

const QWEN = 'Qwen/Qwen3.5-397B-A17B-FP8'
const LLAMA = 'meta-llama/Llama-3.3-70B-Instruct'

// A realistic synth payload: several evidence blocks, not a toy.
const MSGS = [
  { role: 'system', content: 'You are the Virtual Fly Brain assistant. Answer strictly from the EVIDENCE. Cite the dataset for every number. Three to five sentences.' },
  { role: 'user', content: `EVIDENCE
[connectivity] Kenyon cell downstream partners, hemibrain (Scheffer2020), ranked by mean synapses per connected pair:
  mushroom body output neuron  7.09  (n=1642 pairs)
  mushroom body modulatory input neuron  1.96  (n=884 pairs)
  Kenyon cell  1.41  (n=12034 pairs)
[term_info] Kenyon cell (FBbt_00003686): intrinsic neuron of the mushroom body; ~2000 per hemisphere in adult.
[datasets] Scheffer2020 (hemibrain), Dorkenwald2023 (FlyWire), Berg2025 (MaleCNS).

QUESTION: What are the main synaptic partners of Kenyon cells?` }
]

async function run(label, body) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ ...body, messages: MSGS, stream: true })
  })
  if (!res.ok) { console.log(`${label.padEnd(34)} HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); return }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', firstAny = null, firstContent = null, content = '', reasoning = ''
  const keys = new Set()
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
      firstAny ??= Date.now() - t0
      const r = d.reasoning ?? d.reasoning_content
      if (r) reasoning += r
      if (d.content) { firstContent ??= Date.now() - t0; content += d.content }
    }
  }
  console.log(`${label.padEnd(34)} keys=${[...keys].join(',')}`)
  console.log(`   first chunk ${firstAny}ms | first VISIBLE token ${firstContent ?? '-'}ms | total ${Date.now() - t0}ms | reasoning ${reasoning.length} chars | answer ${content.length} chars`)
  console.log(`   ${content.replace(/\n/g, ' ').slice(0, 240)}`)
}

for (let i = 0; i < 2; i++) {
  await run(`qwen thinking-ON #${i}`, { model: QWEN })
  await run(`qwen thinking-OFF #${i}`, { model: QWEN, chat_template_kwargs: { enable_thinking: false } })
  await run(`llama #${i}`, { model: LLAMA })
}
