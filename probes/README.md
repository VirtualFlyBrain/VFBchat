# Probes — the evidence behind ADR 0003

These are the scripts that produced every number in
`docs/adr/0003-qwen-and-per-role-model-configuration.md`. They are kept in the
repository rather than thrown away because an ADR that asserts measurements
without shipping the means to reproduce them is an opinion with a table in it.

They are **not** part of the test suite and are not run by CI: each one talks to
the live ELM gateway, costs real inference time, and is therefore a manual tool.
`npm test` globs `tests/unit/*.test.mjs` and never sees this directory.

## Running them

Each script reads `ELM_API_KEY` from `/tmp/.elmenv` (a copy of `.env.local` —
never commit either). From the repository root:

```
node probes/probe_catalogue.mjs
```

Long-running probes should be backgrounded and polled; several take minutes.

## What each one answers

| Probe | Question it settles |
|---|---|
| `probe_matrix.mjs` | Which capabilities does each ELM model actually have — tool calling, `guided_json`, `json_schema`, context length, reasoning? |
| `probe_roles.mjs` | What does the reasoning stream look like, and which delta field carries it? (`delta.reasoning`, not `reasoning_content`.) |
| `probe_planner.mjs` | Model × thinking × sampling, across eight workshop questions. The source of §2. |
| `probe_planner_sampling.mjs` | Sampling only, everything else held fixed, real tool catalogue. The source of §2a. |
| `probe_extract.mjs` | Does thinking improve extraction? (No — same claims, 24–47s slower.) |
| `probe_haystack.mjs` | At what payload size does each model lose a needle? The source of the `MAX_EXTRACT_CHARS` change in §4. |
| `probe_synth.mjs` | Axis-trap behaviour and time-to-first-token for the streamed answer. §5. |
| `probe_synth_quality.mjs` | Blind comparison of the prose each configuration writes. |
| `probe_agreement.mjs` | How far do k planner samples agree, per question? The complexity signal used by the escalation policy in §7. |
| `probe_v4_wiring.mjs` | Does the role table actually reach vLLM — is `chat_template_kwargs` on the wire? |
| `probe_catalogue.mjs` | Does the served-model catalogue resolve correctly, and does a missing model fall through as designed? §9a. |

## A caveat worth keeping

`probe_v4_wiring.mjs` uses a deliberately minimal five-tool stub catalogue,
because it is testing *plumbing*. Its plans are therefore poor, and that is not
a finding — a planner cannot choose a tool it has not been shown. During v4.0.0
implementation its output was briefly mistaken for evidence that the shipped
sampling profile was wrong; `probe_planner_sampling.mjs` was written with the
real catalogue to settle it, and showed the opposite. **Do not draw quality
conclusions from a probe with a degraded tool catalogue.**
