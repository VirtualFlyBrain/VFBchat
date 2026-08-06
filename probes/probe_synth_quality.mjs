// Synth-role ACCURACY probe. Each case is a trap drawn from a real VFBchat
// defect class (the "confused axes" family that 3.9.2-3.9.4 fixed
// deterministically). The correct behaviour in every case is to answer the
// question that was ASKED, or to say plainly that the evidence does not answer
// it — never to answer the adjacent question as if it were the one asked.
import fs from 'node:fs'

const KEY = fs.readFileSync('/tmp/.elmenv', 'utf8')
  .split('\n').find(l => l.startsWith('ELM_API_KEY=')).split('=')[1].trim()
const BASE = 'https://elm.edina.ac.uk/api/v1'
const QWEN = 'Qwen/Qwen3.5-397B-A17B-FP8'
const LLAMA = 'meta-llama/Llama-3.3-70B-Instruct'
const NOTHINK = { chat_template_kwargs: { enable_thinking: false } }

const SYSTEM = `You are the Virtual Fly Brain assistant. Answer ONLY from the EVIDENCE.
Answer the question that was asked. If the evidence answers a DIFFERENT question, say so explicitly rather than presenting it as the answer.
Attribute every number to the dataset it came from. Never present a count whose provenance you cannot name.
Be complete: if part of the question is unanswered by the evidence, say which part.`

const CASES = [
  {
    id: 'DATASET-AXIS',
    trap: 'Counts are whole-term totals; the question asks per-dataset. Correct: say the per-dataset split is not in the evidence.',
    user: `EVIDENCE
[term_info] DA1 lPN (FBbt_00067046). Available VFB data:
  "Images of DA1 lPN": 47 records
  "Neurons with similar morphology": 250
  "Individual neurons in dataset": count not yet computed (-1)
[datasets] VFB holds Scheffer2020 (hemibrain), Dorkenwald2023 (FlyWire), Berg2025 (MaleCNS).

QUESTION: How many DA1 lPN neurons does VFB hold in each connectome dataset?`
  },
  {
    id: 'DIRECTION-AXIS',
    trap: 'Evidence is DOWNSTREAM partners only; the question asks for INPUTS. Correct: say inputs were not retrieved.',
    user: `EVIDENCE
[connectivity] Kenyon cell DOWNSTREAM partners, hemibrain (Scheffer2020), mean synapses per connected pair:
  mushroom body output neuron 7.09 (n=1642)
  mushroom body modulatory input neuron 1.96 (n=884)

QUESTION: Which neurons provide synaptic INPUT to Kenyon cells?`
  },
  {
    id: 'PARTIAL-COVERAGE',
    trap: 'Two of three datasets have counts; the third failed. Correct: give the two, name the missing one as missing.',
    user: `EVIDENCE
[query NeuronsInDataset] DA1 lPN per dataset:
  Scheffer2020 (hemibrain): 7 neurons
  Dorkenwald2023 (FlyWire): 8 neurons
  Berg2025 (MaleCNS): query returned an error (timeout)

QUESTION: How many DA1 lPN neurons are in each connectome dataset VFB holds?`
  }
]

const CONFIGS = [
  { id: 'llama-t0', model: LLAMA, temperature: 0 },
  { id: 'qwen-think', model: QWEN, temperature: 0.6, extraBody: { top_p: 0.95 } },
  { id: 'qwen-nothink', model: QWEN, temperature: 0, extraBody: NOTHINK }
]

for (const c of CASES) {
  console.log(`\n########## ${c.id} ##########\n(trap: ${c.trap})`)
  for (const cfg of CONFIGS) {
    const t = Date.now()
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: cfg.model, temperature: cfg.temperature, ...(cfg.extraBody || {}),
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: c.user }]
      })
    })
    const j = await res.json()
    const m = j?.choices?.[0]?.message
    const secs = ((Date.now() - t) / 1000).toFixed(1)
    console.log(`\n--- ${cfg.id} (${secs}s, reasoning ${String(m?.reasoning ?? m?.reasoning_content ?? '').length} chars) ---`)
    console.log((m?.content || JSON.stringify(j).slice(0, 300)).trim())
  }
}
