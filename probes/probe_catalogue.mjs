import { readFileSync } from 'node:fs'
import { refreshServedModels, catalogueStatus } from '../lib/modelCatalogue.mjs'
import { describeRoleModels } from '../lib/roleProfiles.mjs'
const KEY = readFileSync('/tmp/.elmenv','utf8').split('\n').find(l=>l.startsWith('ELM_API_KEY=')).split('=')[1].trim()
const baseUrl = 'https://elm.edina.ac.uk/api/v1'
const t0 = Date.now()
const served = await refreshServedModels({ baseUrl, apiKey: KEY })
console.log(`probe ${Date.now()-t0}ms`, JSON.stringify(catalogueStatus()))
console.log('qwen served? ', served?.has('Qwen/Qwen3.5-397B-A17B-FP8'))
console.log('llama served?', served?.has('meta-llama/Llama-3.3-70B-Instruct'))
for (const [label, env] of [
  ['as-deployed today (ELM_MODEL=Llama)', { ELM_MODEL: 'meta-llama/Llama-3.3-70B-Instruct' }],
  ['proposed v4 list',                    { ELM_MODEL: 'Qwen/Qwen3.5-397B-A17B-FP8,meta-llama/Llama-3.3-70B-Instruct' }],
  ['retired head in the list',            { ELM_MODEL: 'Qwen/Qwen4-Imaginary,Qwen/Qwen3.5-397B-A17B-FP8,meta-llama/Llama-3.3-70B-Instruct' }]
]) {
  const r = describeRoleModels({ env, available: served })
  console.log(`\n${label}`)
  console.log('  planner ->', r.roles[0].model, 'think=' + r.roles[0].think, 'temp=' + r.roles[0].temperature)
  r.warnings.forEach(w => console.log('  WARN:', w.slice(0, 150)))
}
