# ADR 0003 — Qwen 3.5, and a per-role model configuration

Status: proposed
Date: 2026-08-06
Supersedes the model-capability findings in ADR 0001
Target release: 4.0.0

## Context

ADR 0001 recorded three facts about the ELM gateway and built the whole
role-harness around them: native tool calling is unavailable, `guided_json` is
enforced, and the only locally-hosted models are Llama 3.3 and EuroLLM. Two of
those three are no longer true.

`GET /models` now returns 55 entries, and the new one is
`Qwen/Qwen3.5-397B-A17B-FP8` with `owned_by: elm` — locally hosted, on the same
gateway, at no cost. `A17B` is a mixture-of-experts activation of about 17
billion parameters, which is why a 397B model answers at 70B speed.

Everything below was measured live against the gateway using VFBchat's own
`buildPlannerMessages`, `PLAN_SCHEMA`, `EXTRACT_SCHEMA` and `callStructured` —
not synthetic benchmarks. The probes are in `scripts/probe-*` (see §8).

## 1. Gateway capabilities, re-probed

| Capability | Llama 3.3 70B | Qwen 3.5 397B-A17B |
|---|---|---|
| Hosting | `owned_by: elm` (local) | `owned_by: elm` (local) |
| `max_model_len` | 131,072 | **262,144** |
| `response_format: json_schema` strict | enforced | enforced |
| vLLM `guided_json` | enforced | **silently ignored** |
| Native tool calling | **HTTP 400** — deployment lacks `--enable-auto-tool-choice` | **works** — `finish_reason: tool_calls` |
| Reasoning | none | on by default; `chat_template_kwargs: {enable_thinking:false}` turns it off |
| Reasoning stream field | n/a | `delta.reasoning` (**not** `reasoning_content`) |

Two of these are worth reporting to EDINA: the Qwen deployment has
`--enable-auto-tool-choice` set while the Llama one still does not, and
`guided_json` is accepted-then-ignored on Qwen rather than rejected. The second
is only survivable because `validateAgainstSchema` re-checks every structured
reply and `callStructured` retries — the guard we built as a fallback is now
carrying the load. It held in every probe run (all first-attempt passes), but it
is now load-bearing rather than belt-and-braces.

## 2. The planner: thinking is what buys the answer

Eight workshop questions, the real planner prompt and schema, temperature 0.

| Config | Valid plans | Latency | W9.1 intent |
|---|---|---|---|
| Llama 3.3, t=0 | 8/8 | 1.4–5.2s | `connectivity` → `vfb_compare_dataset_connectivity` ✗ |
| Qwen, thinking **on**, t=0 | 8/8 | 5.9–13.2s | **`neuron_count`** → resolve → term_info → `vfb_list_connectome_datasets` ✓ |
| Qwen, thinking **off**, t=0 | 8/8 | 1.4–3.0s | `connectivity` ✗ |
| Qwen, thinking off, Qwen-recommended sampling | 8/8 | 1.6–3.5s | `connectivity` ✗ |

W9.1 is "how many DA1 lPN neurons does VFB hold in each connectome dataset" —
the dataset-axis defect that v3.9.3 had to fix deterministically because the
planner kept reaching for the connectivity comparison. Only the thinking
configuration picks the right axis unprompted.

The third and fourth rows matter as much as the second: turning thinking off
loses the win, and Qwen's published sampling recommendation does not bring it
back. **The gain is the reasoning pass, not the model weights and not the
sampling.** Anyone tempted to take Qwen's speed by disabling thinking in the
planner would be taking Llama's judgement with it.

Thinking also improved two plans that Llama got merely thin rather than wrong:
W4.C gains a `vfb_get_term_info` before the connectivity call, and W7.C3 gains a
resolution step plus both connectivity directions instead of one.

Planner latency is invisible: it sits behind the "Planning…" status the client
already renders, and the planner runs once per question.

**Decision: planner → Qwen, thinking on.**

### 2a. Which sampling, settled by measurement rather than by the model card

The table above establishes *thinking on*. It does not establish a temperature:
the winning row ran at t=0, but the shipped profile adopted Qwen's published
thinking preset (t=0.6, top_p 0.95, top_k 20) on the authority of the model
card's "DO NOT use greedy decoding" warning. That is an argument, not evidence,
and it deserved a controlled test before shipping — particularly since a wiring
probe run mid-implementation appeared to show the preset performing badly.

A/B/C holding *everything* else fixed — same model, same real tool catalogue,
same prompt and schema, six questions (the four the agreement probe found
contested, plus two settled controls so a config cannot win by being merely
decisive), varying only the sampling:

| Config | Correct intents | Total latency |
|---|---|---|
| `greedy-think` — t=0, no top_p/top_k | 4/5 | 122.4s |
| **`preset-think` — t=0.6, top_p 0.95, top_k 20 (shipped)** | **4/5** | **88.4s** |
| `lowtemp-think` — t=0.2, top_p 0.95, top_k 20 | 2/5 | 244.3s |

The shipped preset matches greedy decoding on accuracy and is ~28% faster.
`lowtemp-think` is much the worst of the three: it loses W9.1 — the one question
this whole change is justified by — and its W7.C3 call did not return a valid
plan at all inside 184s. Splitting the difference between the model card's
preset and greedy decoding is the one option that is worse than either.

Two things worth recording about how this was reached. First, the alarming
wiring-probe output that prompted the test was an artefact of *that probe's*
five-tool stub catalogue, not of the sampling — a planner cannot choose a tool
it has not been shown, and a probe with a degraded catalogue cannot be used to
draw quality conclusions. Second, the only miss shared by both surviving configs
is W5.C, where the intent label comes back `neuron_profile` while the chosen
tool is `vfb_find_similar_neurons` — the right tool under a different label,
which is arguably a defect in the scoring rather than in the plan.

**Decision: keep the published preset. No profile change.**

## 3. Extraction: thinking is pure cost

Two payloads, each a real VFBchat failure mode, three runs per configuration.
The TRAP payload does not contain a per-dataset breakdown (correct answer:
`answered=false`); the BURIED payload does, under a distractor total (correct
answer: 7 / 8 / 4).

Every configuration got both cases right, every time. The differences were
elsewhere:

| Config | TRAP | BURIED | Latency |
|---|---|---|---|
| Llama 3.3 | ✓ | ✓ "7 in hemibrain, 8 in FlyWire, 4 in MaleCNS" | 0.8–7.5s |
| Qwen, thinking on | ✓ | ✓ same content | **24–47s** |
| Qwen, thinking off | ✓ | ✓ "7 … in Scheffer2020 (hemibrain), 8 in Dorkenwald2023 (FlyWire), 4 in Berg2025 (MaleCNS)" | 0.6–2.1s |

Thinking produced 30 seconds of reasoning to reach the same claim. Thinking-off
Qwen produced the best claim of the three: it carries **both** the dataset
accession and the human label, where Llama drops the accession. That is a small
provenance win repeated on every extraction in every answer, and provenance is
exactly what v3.9.4 was about.

**Decision: extract → Qwen, thinking off.**

## 4. The completeness win: `MAX_EXTRACT_CHARS`

`MAX_EXTRACT_CHARS = 6000` forces every larger tool result through a lossy
map-reduce: each 6k slice is compacted to one claim and one quote, and whatever
the extractor misses in a slice is gone for good. That cap was never a context
limit — 6,000 characters is roughly 1,500 tokens against Llama's 131,072. It is
a *quality* limit, set because a weak extractor loses the needle in a big
haystack.

So I measured the haystack directly: the per-dataset counts buried in the middle
of a realistic result of increasing size.

| Payload | Llama 3.3 | Qwen, thinking off |
|---|---|---|
| 6.3k chars | found, 4.4s | found, 2.3s |
| 24k chars | found, 5.2s | found, 3.1s |
| 48k chars | found, 7.0s | found, 4.0s |
| 97k chars (~24k tokens) | **lost it**, `answered=false` | **found**, 5.9s |

Llama degrades to a silent miss — `answered=false`, no error, evidence simply
absent from the answer. Qwen holds. And note the second column: **Qwen is faster
than Llama at every payload size at or above 6k**, because MoE activation beats
dense attention over long inputs. The "Qwen is the slower model" intuition is an
artefact of thinking mode only.

Raising the cap to 48,000 characters is verified safe and stops the map-reduce
firing on the great majority of results. Fewer lossy compactions is the single
largest completeness improvement available here, and it is a one-constant
change.

**Decision: `MAX_EXTRACT_CHARS` 6,000 → 48,000, conditional on the extract role
running on Qwen.**

## 5. Synthesis: thinking is a UX catastrophe and buys nothing

Three trap cases drawn from the axis-confusion family that v3.9.2–v3.9.4 fixed:
evidence that answers an *adjacent* question (whole-term counts for a
per-dataset question), evidence with the wrong direction (downstream partners
for an inputs question), and evidence with a hole in it (two datasets counted,
the third timed out).

All three configurations passed all three traps. The prompt is doing that work,
not the model. But the streaming numbers are not close:

| Config | Time to first **visible** token | Reasoning emitted | Answer quality |
|---|---|---|---|
| Llama 3.3 | 0.46s | — | correct, plainest prose |
| Qwen, thinking **on** | **34.4s** and **72.9s** on two runs | 9,299 and 20,668 chars | correct, no better |
| Qwen, thinking **off** | 1.0–3.5s | — | correct, and the best of the three |

`route.js` reads `delta.content` only, so reasoning cannot leak into the answer —
but it also means the user watches a blank pane for half a minute while the
model thinks. Twenty thousand characters of reasoning for a 654-character answer
is not a tradeoff, it is waste.

Thinking-off Qwen wrote the best answers in the set: it keeps the `n=1642` pair
counts Llama drops, tags provenance inline as `[Scheffer2020]`, and structures
multi-dataset answers as a list without being asked.

**Decision: synth → Qwen, thinking off.**

## 6. Two defects found on the way, both independent of the swap

**Self-consistency voting is currently theatre.** `liveHarness.mjs` hard-codes
`temperature: 0` in `callStructuredDep`, overriding whatever the caller passes,
and then runs the planner `k=3` through `callStructuredVoted`. Three greedy
generations of the same prompt are three identical strings. The vote costs three
planner calls per question and returns information-free unanimity. Either vote at
a non-zero temperature or do not vote.

**The complexity signal is computed and thrown away.** `callStructuredVoted`
returns `agreement`; `liveHarness.mjs:145` destructures around it and returns
`{ok, value}`. Re-probed at temperature 0.7, agreement does carry signal — W9.1
splits 2/3 — though it also flags three benign cases where the variants differ
only by an optional resolution step. Precision is poor; recall on the one
genuinely hard question is good.

## 7. On routing by complexity

Worth separating two things that look alike.

Choosing a *different model* per question is the expensive kind of routing: it
needs a classifier, the classifier is another call that can be silently wrong,
and a wrong classification is invisible in the output. Choosing *thinking on or
off* is not that. It is one boolean on the same warm deployment — no second
model, no load penalty, no capability divergence. That makes escalation cheap
enough to be liberal with.

VFBchat already tiers questions, deterministically and for free:
`guidanceCards.mjs` classifies each question `simple` / `standard` / `complex`
from which guidance cards matched, and already varies `plannerVotes` and
`maxToolRounds` accordingly. The hook exists; nothing new needs inventing.

But given the stated objective — the most accurate and complete answer, not the
fastest — the honest reading of §2 is that **the planner should simply think on
every question.** Thinking was never worse on any of the eight, it was decisive
on one, and its cost is entirely hidden behind a status message on a
once-per-question call. Routing here would be optimising the one number we have
agreed not to optimise, at the price of a classifier that can silently pick
wrong.

Where routing earns its place is *retrospective*, not predictive: escalate when
the pipeline itself reports trouble, rather than guessing in advance. Three
signals are already computed and two are already discarded — planner vote
disagreement on intent, the sufficiency check returning `answerable:false`, and
the coverage check reporting unanswered asks. Any of those firing is grounds for
one re-plan with a larger thinking budget. That is a decision made on evidence
after the fact, which is the same principle the rest of the harness runs on.

**Decision: think always in the planner; never in extract or synth; reserve
escalation for evidence of trouble, not prediction of it.**

## 8. Recommended configuration

| Role | Model | Thinking | Temperature | Notes |
|---|---|---|---|---|
| planner | Qwen 3.5 397B | **on** | 0.6, `top_p` 0.95, `top_k` 20 | Qwen's published thinking preset; needed anyway if voting is to mean anything |
| extract | Qwen 3.5 397B | off | 0 | determinism wanted; validator + retry backstops the ignored `guided_json` |
| sufficiency | Qwen 3.5 397B | **on** | 0.6 | a judgement call, once per question, latency hidden |
| synth | Qwen 3.5 397B | off | 0.7, `top_p` 0.8, `top_k` 20 | Qwen's published non-thinking preset |

Qwen's model card says plainly: "DO NOT use greedy decoding, as it can lead to
performance degradation and endless repetitions." No repetition appeared in any
probe at temperature 0, and the structured stages want determinism, so temperature
0 stays for extraction — but it should stay as a deliberate, documented exception
rather than an accident of `liveHarness` hard-coding it for every role.

## 9. Code changes for 4.0.0

1. `elmClient.mjs` — add an `extraBody` passthrough merged into the request body.
   Without it `chat_template_kwargs` cannot be sent at all, and every decision
   above is unreachable. (Prototyped; two lines.)
2. `structuredOutput.mjs` — `DEFAULT_MODEL` → the Qwen id; add per-role thinking
   and sampling defaults alongside the existing `VFB_MODEL_<ROLE>` overrides.
3. `liveHarness.mjs` — stop hard-coding `temperature: 0` for every role; thread
   per-role sampling and `extraBody` through `callStructuredDep`; surface
   `agreement` instead of discarding it.
4. `orchestrator.mjs` — `MAX_EXTRACT_CHARS` 6,000 → 48,000.
5. `elmClient.mjs` — raise the planner's `timeoutMs` from 60,000 (one probe run
   took 75.8s across two attempts) and set an explicit `max_tokens`; a reasoning
   model with no output cap can spend the whole budget in the reasoning channel
   and return `content: null`, which reads as "structured output is broken" and
   is not.
6. `APPROVED_ELM_MODEL` enforcement — update for the new baseline.
7. Delete the tool-relay dead code — `buildToolRelaySystemPrompt` (14,874
   characters, ~3.7k tokens), `selectToolDefinitionsForRelay`,
   `TOOL_RELAY_GROUPS`, `compactSchemaForRelay`. `allowToolRelay` is never true;
   the only call site passes `false`.

On (7): Qwen *can* tool-call natively now, so reviving the relay is technically
available for the first time. It should not be. The planner-plus-deterministic-
orchestrator design is precisely what let the axis defects be fixed
deterministically in v3.9.2–v3.9.4; native tool calling hands that control back
to the model. Delete the code, and record here that the option was considered.

## 9a. The pinned-model trap, and why models became a list

The most dangerous thing found during implementation was not in any of the code
above. It was in the deployment environment.

`resolveRoleModel`'s precedence chain is `VFB_MODEL_<ROLE>` → `VFB_MODEL_DEFAULT`
→ `ELM_MODEL` → `OPENAI_MODEL` → `APPROVED_ELM_MODEL` → built-in default.
`ELM_MODEL` **is set in production**, and it outranks the built-in default this
ADR spent nine sections choosing. A 4.0.0 rollout that shipped the code and
forgot the environment would have kept running Llama 3.3 — and said nothing.
The app would still answer every question; it would just answer them worse,
with a planner that no longer reads W9.1 as a count. **A bug with no symptom is
worse than one that breaks the build.**

Worse, before the fix below it would have run Llama *at Qwen's sampling*: the
planner jumping from v3.x's temperature 0 to 0.6 on a model nobody had measured
there. Three mitigations, in increasing order of how much they actually help.

**(i) `legacyTemperature`.** Every profile carries the value v3.x used, and a
model that fails `supportsReasoning()` gets it back. The module's promise that
it "degrades to plain v3.x behaviour" was previously true of the body fields
only; now it is true of the sampling too. A fall back to Llama is a *coherent*
v3.x configuration, not a hybrid nobody has run.

**(ii) Model preference lists.** Every model variable now accepts a comma- or
newline-separated list, and a single value is simply a one-element list — so no
existing deployment changes behaviour, which is what makes this safe to ship in
the same release as the swap. The precedence chain stops being "the first source
that is set wins, full stop" and becomes one flat deduped candidate list. That
matters beyond this rollout: a pinned name is a single point of failure in *two*
directions. Forwards, a stale value silently downgrades the app. Backwards, ELM's
catalogue moves under us — Qwen 3.5 only appeared on it recently, and anything
that can appear can be retired — and under v3.x a name that vanished was not a
degradation but a total outage, every request 404ing. A list survives both.

`lib/modelCatalogue.mjs` supplies the other half, polling `GET /v1/models` on a
TTL so resolution can skip candidates the gateway is not serving. It **fails
open** at every step: a failed, timed-out or never-run probe leaves the snapshot
unknown and resolution filters nothing, i.e. behaves exactly as v3.x. An empty
catalogue is treated as unknown for the same reason — an empty set would filter
every candidate away. The probe is primed, never awaited, so it cannot add
latency to a question, and the snapshot is captured **once per request** and
reused for all five roles: reading it per role would let a refresh landing
mid-question put the planner on one model and the extractor on another, a bug
that reproduces roughly never and is unfalsifiable from the logs when it does.

Verified live: the probe returns ELM's 55-model catalogue in 2.7s; a list of
`Qwen,Llama` resolves to Qwen with thinking on at 0.6; with Qwen removed from
the catalogue the same list resolves to Llama with thinking off at 0, warning
which model was skipped. Model selection, reasoning-body gating and sampling
degradation compose into one coherent fallback with no human in the loop.

One thing was deliberately *not* built. An earlier design had the planner prefer
a reasoning model regardless of the order the operator wrote. It was rejected:
silently overriding operator configuration is the same class of defect this
section exists to fix, and it is unnecessary — `supportsReasoning()` already
adapts to whatever model is chosen. Order stays as written.

**(iii) Saying so out loud.** Lists cannot fix the last case: if an operator
names only Llama, Llama is what runs, because overriding that would be (ii)'s
rejected design. So `describeRoleModels()` reports what every role actually
resolved to, and `route.js` logs it once per process — with a warning naming
both the off-profile model and the variable to change. The v3.x failure was
invisible; that, not the wrong value, was the defect.

The compliance gate came along for the ride. "Configured model equals approved
model" was never the property wanted — it was a proxy that happened to work
while each variable held one name. It is now "every model this deployment could
select is one somebody approved", checked as a subset and applied to the
per-role overrides too, which is strictly stronger: an unapproved model can no
longer be smuggled in as the second entry of an otherwise-approved list.

**Required at deploy time.** Set `ELM_MODEL` (and `APPROVED_ELM_MODEL`) to
`Qwen/Qwen3.5-397B-A17B-FP8,meta-llama/Llama-3.3-70B-Instruct`. The Qwen id must
come first or none of this ADR takes effect; keeping Llama second means a Qwen
outage degrades instead of failing. If it is missed, the startup log now says so.

## 10. Risks

- `guided_json` being ignored on Qwen means schema conformance rests on the
  validator and the retry loop. It held on every probe, but it is now
  load-bearing. Prefer strict `json_schema` wherever the schema is
  strict-compatible, and report the gateway behaviour to EDINA.
- One planner call took 75.8s across two attempts. Thinking-mode latency has a
  long tail; the timeout must accommodate it (item 5) or the tail becomes a
  failure rather than a wait.
- ~~Single-model dependency on one deployment.~~ **Retired by §9a.** A Qwen
  outage now falls through to the next listed candidate automatically, with
  thinking disabled and v3.x sampling restored. The §2 win is lost, as it always
  would be, but it is lost without an operator being paged.
- This is a whole-pipeline model change. It needs the twenty-question workshop
  battery re-run before release, not just the unit suite.

## 11. Unrelated but urgent

The CI task battery that ran against v3.9.4 (`cb4ae62`) reports **1 pass and 51
errors** — 47 `fetch failed`, 4 `terminated`, mean duration 680ms against 35s for
the single run that completed. The whole 52-task run finished in 77 seconds. That
is the dev server dying a few tasks in under `concurrency: 4`, not a regression in
the answers. Combined with the already-reported gating defect — results are
committed even when the battery step fails — the committed battery results for
v3.9.4 are meaningless and should not be read as a quality signal.
