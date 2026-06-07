# ADR 0001 — ELM capabilities and harness direction

Status: accepted
Date: 2026-06-07
Context branch: `feature/role-harness`

## Context

We are redesigning the VFBchat request harness to handle multi-step VFB
questions without overrunning context, and to fix two observed failure modes on
the current single-model loop:

1. routing rules + the original question get lost once large tool results fill
   the shared context window;
2. the model does not reliably know whether it has answered, so it either gives
   up early or falls back on parametric knowledge instead of tool evidence.

Full design: `outputs/reports/vfbchat-harness-design.md` (Cowork workspace).

## Probe results (live ELM, via `scripts/probe-elm-capabilities.mjs`)

Run against `https://elm.edina.ac.uk/api/v1`, model
`meta-llama/Llama-3.3-70B-Instruct`:

| Capability | Result |
|---|---|
| Baseline chat + SSE streaming | PASS |
| `response_format: {type:"json_schema", strict:true}` | PASS — schema-conformant |
| `response_format: {type:"json_object"}` | PASS |
| vLLM `guided_json` | PASS — schema-conformant |
| Native tool calling (`tools` / `tool_choice`) | FAIL — HTTP 400, server lacks `--enable-auto-tool-choice` / `--tool-call-parser` |
| `GET /models` | 54 models. **Locally hosted: only `Llama 3.3` and `EuroLLM`** (both "eco"). All GPT/o-series and Gemini models are proxied off-site (OpenAI/Azure, Google). |

## Decisions

1. **Use constrained decoding (`response_format: json_schema`, strict) for every
   structured step** — planner output, tool-argument objects, term
   disambiguation, extraction rows, completion-judge verdicts. `guided_json` is
   the vLLM-specific fallback. This replaces the brittle free-text JSON relay +
   `findBalancedJsonEnd` repair path as the primary mechanism.

2. **Keep tool calls in-band (no native tool calling), but schema-constrained.**
   Native tool calling is disabled server-side; rather than depend on EDINA
   enabling it, generate the `{tool_calls:[{name, arguments}]}` JSON under a
   strict schema. Optionally raise an infra request to EDINA to launch the Llama
   deployment with `--enable-auto-tool-choice --tool-call-parser llama3_json`.

3. **Stay local by default; there is no stronger local model than Llama-3.3-70B.**
   Only `Llama 3.3` and `EuroLLM` are locally hosted, so the reasoning roles
   (planner, synthesiser, completion-judge) run on Llama-3.3-70B — reliability is
   engineered (constrained decoding, deterministic control, grounding gate,
   self-consistency), not bought with a bigger model. `EuroLLM` ("eco") may serve
   high-volume bounded extraction for throughput relief if a probe confirms
   `response_format` support and adequate accuracy. Make the model per-role
   configurable (`VFB_MODEL_PLANNER` / `VFB_MODEL_EXTRACT` / `VFB_MODEL_SYNTH`,
   default `Llama 3.3`) so a governance-approved frontier model (`GPT 5.x`, `o3`,
   `Gemini 3.x Pro`) can later be slotted into the reasoning roles by config only.
   Using any proxied model is a **data-governance decision** (VFB user queries +
   evidence leave EDINA infra) and must be cleared before use. Re-probe every
   non-Llama candidate (`guided_json` is vLLM-only; proxied models need OpenAI
   strict `json_schema`).

4. **Deterministic controller + typed ledger, no agent-to-agent chat.** Roles are
   single-purpose bounded calls communicating through a shared typed state owned
   by code; the controller (not an LLM) decides completion via a checklist of
   planner-emitted sub-questions, each satisfied only when a provenance-tagged
   evidence row covers it. Synthesiser sees evidence only; a grounding pass
   strips unsupported claims.

## Open items

- Confirm ELM rate / concurrency limits (bounds parallel fan-out and
  self-consistency k).
- Verify `response_format` parity on the chosen strong model.
