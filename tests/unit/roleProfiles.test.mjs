// Tests for the per-role model / sampling / reasoning table.
// Run: node --test tests/unit/roleProfiles.test.mjs
//
// These are the guards on the three ways v4.0.0 can silently regress:
//   1. a reasoning-only body field leaking onto a non-reasoning model,
//   2. thinking being switched off in the one role where it was measured to
//      change the answer, and
//   3. greedy decoding reaching a channel Qwen's model card says it breaks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROFILES,
  ROLES,
  PLANNER_ESCALATION,
  QWEN_MODEL,
  LLAMA_MODEL,
  supportsReasoning,
  roleForSchemaName,
  roleRequestOptions,
  __TEST__
} from '../../lib/roleProfiles.mjs'

// A clean env: no ambient VFB_*/ELM_* leakage from the developer's shell.
const EMPTY = Object.freeze({})

test('every role has a complete profile and the table is frozen', () => {
  assert.deepEqual(ROLES, ['planner', 'sufficiency', 'extract', 'args', 'synth'])
  for (const role of ROLES) {
    const p = PROFILES[role]
    assert.equal(typeof p.think, 'boolean', role)
    assert.equal(typeof p.temperature, 'number', role)
    assert.ok(p.timeoutMs > 0, role)
    assert.ok(p.maxTokens > 0, role)
    assert.ok(Object.isFrozen(p), `${role} profile must be frozen`)
  }
  assert.ok(Object.isFrozen(PROFILES))
})

test('thinking is on for the two judgement roles and off for the rest', () => {
  // The probe result this encodes: planner-with-thinking is the ONLY config that
  // reads W9.1 as a count question. Extract/synth with thinking cost 24-73s for
  // byte-identical content. If someone flips these, this test is the argument.
  assert.equal(PROFILES.planner.think, true)
  assert.equal(PROFILES.sufficiency.think, true)
  assert.equal(PROFILES.extract.think, false)
  assert.equal(PROFILES.args.think, false)
  assert.equal(PROFILES.synth.think, false)
})

test('no prose-generating role runs greedy; both extraction roles do', () => {
  // Qwen's model card: greedy decoding "can lead to performance degradation and
  // endless repetitions". Transcription roles are exempt — determinism is worth
  // more there and the schema validator backstops degenerate output.
  assert.ok(PROFILES.planner.temperature > 0)
  assert.ok(PROFILES.sufficiency.temperature > 0)
  assert.ok(PROFILES.synth.temperature > 0)
  assert.equal(PROFILES.extract.temperature, 0)
  assert.equal(PROFILES.args.temperature, 0)
})

test('reasoning roles carry enough token budget for the reasoning channel', () => {
  // A reasoning model spends its budget on the thinking channel FIRST. The very
  // first json_schema probe against Qwen came back `content: null` purely
  // because max_tokens was 2500. 16k is ~4x the largest observed trace.
  assert.ok(PROFILES.planner.maxTokens >= 16384)
  assert.ok(PROFILES.sufficiency.maxTokens >= 16384)
})

test('supportsReasoning recognises the Qwen 3+ family and nothing else', () => {
  assert.equal(supportsReasoning(QWEN_MODEL), true)
  assert.equal(supportsReasoning('Qwen/Qwen3-32B'), true)
  assert.equal(supportsReasoning('qwen3.5-397b-a17b-fp8'), true)
  assert.equal(supportsReasoning('Qwen/Qwen4-Next'), true)
  // Unrecognised is treated as non-reasoning, which is the safe direction:
  // we simply omit the extra body fields rather than send an unknown template
  // variable into somebody else's Jinja.
  assert.equal(supportsReasoning(LLAMA_MODEL), false)
  assert.equal(supportsReasoning('Qwen/Qwen2.5-72B-Instruct'), false)
  assert.equal(supportsReasoning(''), false)
  assert.equal(supportsReasoning(undefined), false)
  assert.equal(supportsReasoning(null), false)
})

test('roleForSchemaName joins orchestrator schema names to roles', () => {
  assert.equal(roleForSchemaName('plan'), 'planner')
  assert.equal(roleForSchemaName('sufficiency'), 'sufficiency')
  assert.equal(roleForSchemaName('extract'), 'extract')
  assert.equal(roleForSchemaName('vfb_query_connectivity_args'), 'args')
  assert.equal(roleForSchemaName('vfb_get_term_info_args'), 'args')
  // Unknown schemas fall back to the cheapest safe profile, never the planner.
  assert.equal(roleForSchemaName('something_new'), 'extract')
  assert.equal(roleForSchemaName(''), 'extract')
  assert.equal(roleForSchemaName(), 'extract')
})

test('roleRequestOptions defaults to Qwen and emits the reasoning body', () => {
  const planner = roleRequestOptions('planner', { env: EMPTY })
  assert.equal(planner.role, 'planner')
  assert.equal(planner.model, QWEN_MODEL)
  assert.equal(planner.think, true)
  assert.equal(planner.temperature, 0.6)
  assert.deepEqual(planner.extraBody.chat_template_kwargs, { enable_thinking: true })
  assert.equal(planner.extraBody.top_p, 0.95)
  assert.equal(planner.extraBody.top_k, 20)
  assert.equal(planner.extraBody.max_tokens, 16384)

  // enable_thinking is stated in BOTH directions on purpose: vLLM's Qwen
  // template defaults thinking ON, so "off" has to be said out loud, and saying
  // "on" means an upstream default flip cannot silently change the planner.
  const extract = roleRequestOptions('extract', { env: EMPTY })
  assert.deepEqual(extract.extraBody.chat_template_kwargs, { enable_thinking: false })
  assert.equal(extract.think, false)
  assert.equal(extract.temperature, 0)
  // extract's profile has no top_p/top_k, so neither is emitted.
  assert.equal('top_p' in extract.extraBody, false)
  assert.equal('top_k' in extract.extraBody, false)
})

test('a non-reasoning model degrades to plain v3.x behaviour', () => {
  // The whole point of gating on supportsReasoning: pinning APPROVED_ELM_MODEL
  // back to Llama must not send Qwen-only fields into Llama's chat template.
  for (const role of ROLES) {
    const o = roleRequestOptions(role, { env: { VFB_MODEL_DEFAULT: LLAMA_MODEL } })
    assert.equal(o.model, LLAMA_MODEL, role)
    assert.equal(o.think, false, `${role}: thinking is impossible on Llama`)
    assert.equal('chat_template_kwargs' in o.extraBody, false, role)
    assert.equal('top_p' in o.extraBody, false, role)
    assert.equal('top_k' in o.extraBody, false, role)
    // max_tokens is model-agnostic and stays.
    assert.equal(o.extraBody.max_tokens, PROFILES[role].maxTokens, role)
  }
})

test('a non-reasoning model also gets v3.x SAMPLING back, not just v3.x body', () => {
  // Found by the live wiring probe, not by the unit tests: ELM_MODEL is set in
  // the deployment environment and outranks this module's Qwen default, so a
  // rollout that forgets to move it lands on Llama — where the Qwen presets are
  // an untested change (planner 0 -> 0.6), not a neutral default.
  const env = { VFB_MODEL_DEFAULT: LLAMA_MODEL }
  for (const role of ['planner', 'sufficiency', 'extract', 'args']) {
    assert.equal(roleRequestOptions(role, { env }).temperature, 0, `${role} must be greedy on Llama`)
  }
  // v3.x sent NO temperature on the synth stream, so neither do we: null here,
  // and absent from `sampling` so it is never serialised as `"temperature": null`.
  const synth = roleRequestOptions('synth', { env })
  assert.equal(synth.temperature, null)
  assert.equal('temperature' in synth.sampling, false)
  assert.deepEqual(synth.sampling, { max_tokens: PROFILES.synth.maxTokens })

  // And on Qwen the presets are restored in full.
  const onQwen = roleRequestOptions('synth', { env: {} })
  assert.equal(onQwen.sampling.temperature, 0.7)
  assert.equal(onQwen.sampling.top_p, 0.8)
})

test('an explicit env temperature still wins on a non-reasoning model', () => {
  const o = roleRequestOptions('synth', {
    env: { VFB_MODEL_DEFAULT: LLAMA_MODEL, VFB_TEMPERATURE_SYNTH: '0.3' }
  })
  assert.equal(o.temperature, 0.3)
  assert.equal(o.sampling.temperature, 0.3)
})

test('sampling never carries a non-numeric temperature', () => {
  for (const env of [{}, { VFB_MODEL_DEFAULT: LLAMA_MODEL }]) {
    for (const role of ROLES) {
      const s = roleRequestOptions(role, { env }).sampling
      if ('temperature' in s) assert.equal(typeof s.temperature, 'number', role)
    }
  }
})

test('per-role model overrides beat the default, explicit model beats both', () => {
  const env = { VFB_MODEL_DEFAULT: LLAMA_MODEL, VFB_MODEL_PLANNER: QWEN_MODEL }
  assert.equal(roleRequestOptions('planner', { env }).model, QWEN_MODEL)
  assert.equal(roleRequestOptions('extract', { env }).model, LLAMA_MODEL)
  // An explicit model argument (the harness passing its own resolved map) wins.
  assert.equal(roleRequestOptions('extract', { env, model: QWEN_MODEL }).model, QWEN_MODEL)
  // Blank/whitespace explicit model is ignored rather than producing a blank id.
  assert.equal(roleRequestOptions('extract', { env, model: '   ' }).model, LLAMA_MODEL)
})

test('env overrides reach thinking, temperature, timeout and token budget', () => {
  const o = roleRequestOptions('planner', {
    env: {
      VFB_THINKING_PLANNER: 'off',
      VFB_TEMPERATURE_PLANNER: '0.2',
      VFB_TIMEOUT_PLANNER: '5000',
      VFB_MAX_TOKENS_PLANNER: '1024'
    }
  })
  assert.equal(o.think, false)
  assert.equal(o.extraBody.chat_template_kwargs.enable_thinking, false)
  assert.equal(o.temperature, 0.2)
  assert.equal(o.timeoutMs, 5000)
  assert.equal(o.maxTokens, 1024)
  assert.equal(o.extraBody.max_tokens, 1024)

  // Overrides are scoped to their own role, not global.
  const untouched = roleRequestOptions('sufficiency', { env: { VFB_THINKING_PLANNER: 'off' } })
  assert.equal(untouched.think, true)
})

test('temperature 0 is corrected upward only while thinking is on', () => {
  // Greedy + reasoning is the documented failure mode. Greedy + no reasoning is
  // exactly what we want for extraction, so the correction must not fire there.
  const thinking = roleRequestOptions('planner', { env: { VFB_TEMPERATURE_PLANNER: '0' } })
  assert.equal(thinking.think, true)
  assert.equal(thinking.temperature, 0.6)

  const notThinking = roleRequestOptions('planner', {
    env: { VFB_TEMPERATURE_PLANNER: '0', VFB_THINKING_PLANNER: '0' }
  })
  assert.equal(notThinking.think, false)
  assert.equal(notThinking.temperature, 0, 'greedy is legitimate with thinking off')

  const extract = roleRequestOptions('extract', { env: EMPTY })
  assert.equal(extract.temperature, 0)
})

test('unknown roles fall back to the extract profile rather than throwing', () => {
  const o = roleRequestOptions('not-a-role', { env: EMPTY })
  assert.equal(o.role, 'extract')
  assert.equal(o.think, false)
  assert.equal(o.temperature, 0)
})

test('envFlag and envNumber ignore junk instead of guessing', () => {
  const { envFlag, envNumber } = __TEST__
  for (const yes of ['1', 'true', 'TRUE', ' on ', 'yes']) assert.equal(envFlag(yes), true, yes)
  for (const no of ['0', 'false', 'OFF', 'no']) assert.equal(envFlag(no), false, no)
  // Undefined means "no opinion" -> the profile default stands. Critically,
  // junk must NOT read as false: VFB_THINKING_PLANNER=maybe silently disabling
  // the planner's reasoning pass is the exact regression this guards.
  for (const junk of ['maybe', '', '   ', undefined, null]) assert.equal(envFlag(junk), undefined)

  assert.equal(envNumber('0'), 0)
  assert.equal(envNumber('0.6'), 0.6)
  assert.equal(envNumber('-1'), -1)
  for (const junk of ['abc', '', '  ', undefined, null]) assert.equal(envNumber(junk), undefined)
})

test('planner escalation policy is bounded and self-consistent', () => {
  assert.ok(PLANNER_ESCALATION.minAgreement > 0 && PLANNER_ESCALATION.minAgreement <= 1)
  assert.ok(PLANNER_ESCALATION.extraVotes >= 1)
  // One round only. If six samples cannot agree, a seventh is not the fix — the
  // sufficiency loop downstream is a better place to recover.
  assert.equal(PLANNER_ESCALATION.maxRounds, 1)
  assert.ok(Object.isFrozen(PLANNER_ESCALATION))
})
