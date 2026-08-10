# Release Notes

This file summarizes the release notes inferred from git tags (tag message/annotation). It is intended to preserve release history in the repository.

---

## v4.2.2
- Release v4.2.2: An answer may no longer tell a user that Virtual Fly Brain holds nothing until something has actually looked.

  **The rule existed and nothing enforced it.** `lib/coverage.mjs` has said since the four-state model was introduced that of RUN, EMPTY, FAILED and UNRUN, only EMPTY licenses an absence; the synthesis prompt repeats it three times in capitals. Measured against production v4.2.1 — thirteen questions, three repetitions each, judged blind — **eighteen of thirty-nine answers asserted that VFB holds nothing, and not one had a query behind it that had run and come back empty.** This release takes that to one in thirty-nine. It is the same lesson the project learned for counts in 4.1.x, where the answer was not a firmer instruction but `repairMistranscribedCounts`: state the rule, then enforce it deterministically after the model has had its say.

  **Three of those denials were about classes the ontology has held for years,** because the wording a fly neuroanatomist types and the wording VFB's index answers to are different strings. Against the live index: `γ Kenyon cell` returns zero documents and `gamma Kenyon cell` is an exact label match for FBbt_00100247; `α/β Kenyon cell` zero and `alpha/beta Kenyon cell` FBbt_00100248; `MBON-γ1pedc>α/β` zero and `MBON-gamma1pedc>alpha/beta` FBbt_00100246 at rank one. The quieter form of the same fault is more dangerous than the zero-hit one: `MBON-α′1` returns eighty documents *without* the term among them, so the resolver has plenty to pick from and no signal that it should not, where `MBON-alpha'1` puts FBbt_00111010 first. `lib/nameNormalise.mjs` transliterates Greek to the spellings FlyBase and FBbt actually store and normalises primes, arrows, dashes and non-breaking spaces. It is the first rung of `nameVariants` and only fires when there is something to transliterate, so an ASCII name still pays exactly one extra search for its plural.

  **Going and looking, rather than conceding.** If the drafted answer claims an absence and nothing came back empty, the harness injects the failed and the most relevant unrun queries and writes the answer again — failed first, because a lookup that fell over is the one case with positive evidence that the absence is an artefact. Relevance orders those attempts but does not veto them, and that distinction is load-bearing: "are any mushroom body output neurons cholinergic?" scores every query the class advertises at zero, because relevance compares a query label's words with the question's and no label contains "cholinergic" — while `SubClasses`, scoring zero, is exactly the query that answers it by enumerating the 34 subtypes. Filtering here would have escalated nothing in the case the guard exists for.

  **A query the guard chose cannot license the claim it was chosen to check.** An early cut ran `ListAllAvailableImages` for a question about hemisphere symmetry, got an empty result, and licensed the symmetry denial with it — the guard manufacturing its own permission, which is worse than the bug it replaces, because the false claim now ships with something that looks like evidence behind it. An empty from an escalation-chosen query no longer licenses absence. The cost is real and is the right way round: a run where escalation genuinely proves an absence now hedges it instead of stating it flatly. Hedging a true absence is a worse answer; asserting a false one is a wrong answer.

  **`gateAbsence` is the floor, not the fix.** It removes absence claims the ledger does not license, and by the time it fires escalation has already had its chance. `renderShelf` also gained a NAMES THAT DID NOT MATCH block for the half-resolved question — one term matches, another does not, the shelf is non-empty so the no-coverage floor never fires, and nothing in the prompt distinguished "never looked at" from "checked and found wanting". That is how a comparison of the lobula with the medulla resolved only the medulla, queried only the medulla, and reported the difference as a difference in what VFB holds.

  **Three defects the measurement exposed on the way.** `harnessFraming` was producing the framing it exists to remove: `EVIDENCE_SUBJECT` needs "the evidence", `INPUT_NOUN` matches "the provided evidence" as a unit and rewrites it to "VFB evidence", so the subject rules ran first, found "provided" in the way, did nothing, and the noun rule then produced exactly the subject they would have handled, one pass too late — shipping "VFB evidence lists queries for subclasses, scRNAseq data … but it does not include a completed query", which is this program's working set wearing VFB's name. The rules were right and their order was wrong. Definitions were being summarised twice: "what is the ellipsoid body?" returned the same 254 characters on all three repetitions, dropping the ellipsoid body canal, the anterior bundle, the 16 radial segments and the Ito et al. citation, because the extractor is a weak model summarising the whole term-info record into one claim and a definitional question went through two paraphrase hops before reaching the reader. The description is now carried verbatim as its own evidence row — 254 characters to 471, all three sentences and the citation intact. And the escalation had no sense of time, buying a second synthesis at three minutes on a run that then timed out, turning a usable if hedged answer into "the language service did not respond"; it now stops at `ABSENCE_ESCALATION_DEADLINE_MS`, 120 s and env-tunable, derived from the tighter of the two ceilings in the system rather than from the run deadline alone.

  **Numbers.** Same thirteen questions, three repetitions each: unlicensed absence claims 18 → 1, errors 0 → 0, median 66 s → 77 s, worst case 429 s → 246 s. The 64-task battery is 64/64 with no errors. 1188 unit tests, no failures; every positive case in `tests/unit/absence.test.mjs` is a string production actually produced.

  **Known limits,** recorded in `docs/adr/absence-requires-evidence.md` rather than papered over: a licence is per-run and not per-claim, so one genuinely empty query still entitles every absence sentence in that answer, and narrowing it needs claim-to-query matching that is not reliably decidable from the text; and the detector is a pattern list grown from sentences production actually wrote, so it should keep growing from observed output rather than from imagination, with a negative case beside each addition — "serotonin is not present in these neurons" is a claim about the world and must survive.

## v4.2.1
- Release v4.2.1: A request nobody is waiting for now stops, an MCP result is parsed once instead of five times, and two gates that were documented and tested but never called are wired to the thing that actually knows the answer.

  **Cancellation.** `buildSseResponse` had no `cancel()` handler, `request.signal` was never wired into the harness, the MCP client or the ELM client, and the enqueue-failed branch carried a comment saying there was nothing else to do when the client disconnected. There was: stop. A user who waited forty seconds and hit refresh three times left three complete working sets running to completion — up to 82 controller iterations and 24 MCP rounds each, holding a ledger, its term-info records, its evidence array and every tool payload for the whole run, so four questions in flight could be doing the work of eight. `lib/runSignal.mjs` is one signal per request, aborted by whichever comes first of the client disconnecting, the stream being cancelled, or a deadline; it is checked at the top of every controller iteration and before every tool round, and passed to the ELM fetch so a call already in flight is cancelled rather than merely not started. Verified against a running server rather than assumed: `next start` fires both hooks, and four questions abandoned after six seconds now produce four `RUN ABANDONED` lines and zero completed answers in four and a half minutes, against an answer that takes 90–210 s. An abandoned run is also no longer recorded as a service error, which was writing an `errored=true` governance record and emitting an error event to a client that had already gone.

  **One MCP result was materialised five times, with every copy alive at once** — joined by `mcpResultToText`, `JSON.parse`d by the graph collector, regex-scanned twice for thumbnails, `JSON.parse`d again purely to test one key, `JSON.parse`d a third time by the orchestrator, then stringified back by `asText` and sliced into a second full copy by `chunkText`. At ~20 MB of JSON, which `ListAllAvailableImages` on the medulla reaches at 226k rows, that is three independent V8 object graphs at 5–10× the text size plus ~60 MB of string copies, for one tool call out of 24, all synchronous on the single event loop. It is not a leak; it is 5× amplification of an uncapped payload, and it is the shape of 88 MB → 6.8 GB across four concurrent questions. Parse once, reuse it, and above `MAX_TOOL_RESULT_CHARS` build no object graph at all. Four further things were sized by the payload rather than by what the answer uses: the extract map-reduce split an oversized result into unbounded chunks with one three-minute ELM call each; thumbnails accumulated without a cap while the dedupe `Set` was rebuilt from the whole accumulated array on every tool call, to render eight images; `backfillDigestPreview` mapped every row to keep five; and the reviewed-docs page cache was TTL-checked on read and never deleted.

  **Synchronous disk I/O off the request path.** Every request did two full read-modify-write cycles on the shared event loop — the entire 30-day rate-limit state before any work started, the whole day's analytics bucket at the end — plus five `readdirSync` calls for the retention sweep. Both counters are aggregates and are now buffered with a timed write-through and an exported flush; anything with a legal retention requirement is still appended synchronously. The retention sweep is throttled to hourly while keeping the property its test was written for, that it runs on a long-lived container rather than once at startup. The rate-limit map is bounded, because its key is the leftmost value of `X-Forwarded-For` and a client that forges a fresh one each time both defeated the limit and grew the map.

  **Two gates that were not gates.** `priorTermQueries` is documented as validating a clicked chip's `{id, query_type}` before it runs; it had a unit test and exactly one occurrence in non-test code, its own definition, so a stale or client-authored chip passing two shape regexes went to the MCP, was rejected, and came back as "VFB does not currently hold …" about a term the same answer hyperlinks. It could not have been that gate: the carried context is truncated, so absence from it is not evidence. Chip steps are now marked `via_chip` and reconciled against VFB's own catalogue after resolution, with the type lift getting first refusal. And the clarify branch returned the model's text raw with `blockedResponseDomains: []` hard-coded, while every other exit went through five sanitisers.

  **Also:** MCP sessions leaked one per extra concurrent name, because `getMcpClientForContext` was check-then-await-then-set and `resolveTerms` fans out with `Promise.all`; the force-refresh allowance documented as two recomputes per request was passed by one of its 27 call sites, so a single reciprocal-connectivity call could fire seven; `/api/feedback` had no rate limit and no authentication despite appending up to 100 KB of transcript to a 30-day store; a fetched documentation page was concatenated into the prompt with no boundary, and a fenced block was lifted verbatim as something to copy, which is right for a configuration and wrong for a shell command. The unreachable `stop` action is gone, and so is the static lookup cache whose 1,500 compiled RegExps ran over every question and were thrown away unread.

  1150 unit tests, no failures.

## v3.9.1
- Release v3.9.1: Remove the dead tool-output compression path. Before resource handles existed, an oversized relay payload was truncated at `VFB_TOOL_OUTPUT_TRUNCATE_CHARS` and, past a total trigger, split into chunks for a summarisation pass — `truncateToolOutput`, `shouldCompressToolOutputs`, `buildToolOutputCompressionChunks` and `getRelayToolOutput`, tuned by five environment variables. The `data_resource` threshold introduced later intercepts every payload large enough to reach that path, so nothing has called any of the four functions for several releases; `getRelayToolOutput` read an `item.relayOutput` field that no code anywhere writes, which makes the whole relay-output concept vestigial. Dead code of this shape is worse than merely unused: it advertises a safety net that is not there. A reader of `route.js` — or of a deployment's environment — would reasonably conclude that oversized outputs are still truncated as a second line of defence, and would size `DATA_RESOURCE_INLINE_MAX_CHARS` accordingly. They are not: the resource threshold is the only thing standing between a large tool result and the prompt, and anything that survives it is sent whole. 100 lines removed from one file, no behaviour change, no test change (701/701 still green), and `docs/tool-result-resource-strategy.md` now says so explicitly rather than describing the removed path. The five variables — `VFB_TOOL_OUTPUT_TRUNCATE_CHARS`, `VFB_TOOL_OUTPUT_COMPRESSION_TOTAL_TRIGGER_CHARS`, `VFB_TOOL_OUTPUT_COMPRESSION_CHUNK_CHARS`, `VFB_TOOL_OUTPUT_COMPRESSION_MAX_INPUT_CHARS` and `VFB_DISABLE_TOOL_RESULT_COMPRESSION` — are no longer read and can be deleted from any deployment that still sets them. `stringifyToolOutput` is deliberately kept: it is live in the resource-storage decision.

## v3.9.0
- Release v3.9.0: The shelf is now acted on rather than read out, and a lookup that was abandoned no longer poses as a lookup that came back empty. 3.8.0 built a correct catalogue of every query each resolved term advertises; the twenty workshop questions then showed four distinct ways of misusing it. (A) Relevance was lexical — a query matched the question when their words overlapped, so "what are the main synaptic partners" scored no higher on a connectivity query than on an image query. `lib/queryTypes.mjs` now declares the KIND of question each query type answers and `lib/queryRelevance.mjs` scores on kind intersection, with kinds the question explicitly excludes scoring negative. (B) The shelf was narrated instead of used: answers ended "VFB also holds 92 transgene expression records, but this query has not been run yet", which reports on the harness rather than on the fly. The synthesis rules now say plainly that an unrun query is a thing to RUN, not a thing to mention, and `lib/harnessFraming.mjs` strips the residue deterministically when the model says it anyway. (C) An empty shelf gave no prohibition at all — when nothing resolved, `renderShelf` returned an empty string and the absence rules went with it, which is precisely the case that most needs them; there is now an unconditional no-coverage floor, ignorance counts as insufficiency rather than sufficiency, and the two fast paths that were hijacking multi-step and connectivity questions are vetoed. (D) One question errored after 300 s with 181 s spent inside term resolution before any data query ran: a 30 s timeout is classified transient, so each retry was granted another full 30 s and the retry count became a silent latency multiplier (30 + 2 + 30 + 3 + 30 ≈ 95 s per lookup, twice per name). `lib/callBudget.mjs` states the allowance ONCE as a total for the whole attempt sequence — every attempt and every backoff draws from it, so a retry that only fits in 12 s is given 12 s rather than 30 — and the resolve ladder gets a per-name wall-clock deadline that abandons its speculative rungs (spelling variants, the dataset-index sweep) while never touching the rungs the answer is made of. Worst case falls from ~181 s to ~90 s and is now bounded rather than emergent. Crucially, an abandoned lookup is recorded as abandoned: it is reported to the synthesiser as "the lookup did not complete", never as "VFB's search returned nothing", because the wordings that were skipped are exactly the ones that would have matched.

## v3.8.0
- Release v3.8.0: Coverage is now tracked per QUERY, not per term. 3.7.0 forbade an absence about anything the AVAILABLE VFB DATA block listed, but the block itself was withheld the moment any planned step produced evidence — so one query running took the prohibition down with it, and eight of twenty workshop answers still denied records VFB was holding. The unit was wrong in two places: the synthesis gate suppressed the whole catalogue on the first answered step, and the sufficiency pre-filter counted a term as covered once one of its five queries had run. A new `lib/coverage.mjs` builds a shelf of every query every resolved term advertises and sorts each into one of four states — RUN (answer from evidence), EMPTY (the only state that licenses an absence), FAILED (a lookup that fell over, which licenses nothing but keeps its counts) and UNRUN (held, never asked, and forbidden to deny). The block that used to do two jobs at once now does them separately: the prohibition is unconditional and complete, while the licence to name a follow-up query is scoped to a WORTH SAYING list of at most two queries the question actually asked for that nothing already run covers — which fixes the catalogue-as-a-tail padding the old suppression was hacked in to stop, rather than hiding the list to avoid it. Relevance scoring moves to `lib/queryRelevance.mjs` so the shelf can be ranked and capped by what the question asked rather than by the order VFB returned. Also: the catalogue is now gated on the QUESTION (a definitional question has no absence to guard), definitively-empty query results are recorded as such rather than as failures, and a new synthesis rule stops the model handing back a `vfb.terms([...])` snippet in place of the result it was asked for.

## v3.7.0
- Release v3.7.0: Absence in an answer now requires a lookup that actually happened. Seven of twenty workshop questions were answered "VFB does not currently hold data on X" about terms whose own digests advertised exactly X, with the query sitting available and un-run — nothing distinguished QUERIED AND EMPTY from NEVER QUERIED. Three layers: the synthesis absence gate now keys on a query having run and come back empty, and the AVAILABLE VFB DATA block states its queries are unrun and forbids an absence about anything it covers; a new ledger-level sufficiency check runs before synthesis, asking which of the un-run queries would answer the question and injecting it (one shot, deterministically pre-filtered, on the ledger rather than the streamed prose so it can still re-plan); and three deterministic injectors were widened to reach a region asked a connectivity question, a counted query asked for its members, and a question resolving two terms.

## v3.3.0
- Release v3.3.0: Reviewed-docs search plane — run an approved-domain documentation search in parallel to supplement every answer, with page citations in Sources; scRNA-seq gene-expression rendered as deterministic gene x subtype tables; published neuron-count estimates surfaced with their citation; role-harness reliability work — deterministic connectivity-graph routing for neuron types, intent-scoped guidance cards, answer-grounding guards, and more robust token-superset term resolution; route dataset-listing questions to vfb_list_connectome_datasets; split VFB MCP timeouts by call weight; thumbnail link/label fixes; and VFB3-MCP 1.9.1 compatibility (run_query paging/image controls, FlyBase stock/combination-publication query_types, parallel population).

## v3.2.4
- Release v3.2.4: Fix zero-count VFB query links and include the latest merged 5point5Review changes.

## v3.2.3
- Release v3.2.3: Recover with partial answers or clarifying follow-ups after upstream stream failures when tool evidence already exists, prioritize gene-expression classification over connectivity for analytics, and bias broad transgene-expression requests toward short representative lists

## v3.2.2
- Release v3.2.2: Restore production compatibility when explicit approved ELM values are not configured, add partial-summary and clarification fallbacks for broad tool-heavy queries, raise the tool-round budget to 10, and add named example asset generation

## v3.2.1
- Release v3.2.1: Expand approved site search beyond a hand-maintained VFB page list by adding wider sitemap-backed reviewed search, approved page extraction, and NeuroFly domain allow-list support

## v3.2.0
- Release v3.2.0: Add governance-ready logging with `/logs` volume support, reviewed-domain search controls, outbound link allow-listing, structured feedback, privacy updates, and opt-in transcript attachments for problem reports

## v3.1.0
- Release v3.1.0: Add per-IP daily rate limiting and rate-info endpoint; backend data storage in data/rate-limits.json; client-side usage counter in UI

## v3.0.3
- Release v3.0.3: Fix thumbnail handling by avoiding ID linkification inside existing URLs

## v3.0.2
- Release v3.0.2: Improve linked ID display by using preferred labels (e.g., “ME on JRC2018Unisex” instead of raw ID)

## v3.0.1
- Release v3.0.1: Add VFB report link generation and improved term linking

## v3.0.0
- Release v3.0.0

## v2.2.23
- Add retry logic and sanitize API error responses

## v2.2.22
- Bump version to 2.2.22

## v2.2.21
- Refactor message rendering with memoization and unique message IDs

## v2.2.20
- Bump version to 2.2.20

## v2.2.19
- Bump version to 2.2.19

## v2.2.18
- v2.2.18: Add interactive suggested questions from gpt-5-nano responses

## v2.2.17
- Release 2.2.17: Fix dataset search filtering

## v2.2.16
- Fix runtime error: add missing conversationMessages variable definition

## v2.2.15
- Release v2.2.15: Fix complex term information retrieval

## v2.2.14
- Release v2.2.14: VFB_connect-style lookup methodology

## v2.2.13
- Update release notes for v2.2.13

## v2.2.12
- Release v2.2.12: Add thumbnail URL validation

## v2.2.11
- Release 2.2.11: Fix critical tool call processing bug

## v2.2.10
- Release 2.2.10: Add table rendering and improve connectivity query guidance

## v2.2.9
- Release v2.2.9: Query optimization and hallucination prevention

## v2.2.8
- Release v2.2.8: FlyBase Link Fix

## v2.2.7
- Release v2.2.7: Image Display Fix

## v2.2.6
- Release v2.2.6: Context Fix

## v2.2.5
- Release v2.2.5: Precise VFB data structure logic for thumbnails

## v2.2.4
- Release v2.2.4: Improve thumbnail selection with Images vs Examples handling

## v2.2.3
- Release v2.2.3: Fix AI hallucinating thumbnail URLs

## v2.2.2
- Release v2.2.2: Improve paper citation formatting

## v2.2.1
- Release v2.2.1: Fix thumbnail URL display issue

## v2.2.0
- Bump version to 2.2.0 for analytics and AI guidelines release

## v2.1.1
- Release v2.1.1: Add jailbreak detection and security features

## v2.1.0
- feat: add image thumbnails, guardrails, and fix nested link corruption

## v2.0.1
- fix: improve UI layout, markdown rendering, and term link replacement

## v2.0.0
- feat: migrate LLM backend from Ollama to OpenAI API

## v1.1.2
- Bump version to 1.1.2

## v1.1.1
- Release v1.1.1: Fix MCP session issues with official SDK

## v1.1.0
- Bump version to 1.1.0 - Added MCP SDK session management

## v1.0.5
- Enhance status message feedback for MCP operations

## v1.0.4
- Fix syntax errors causing Docker build failures

## v1.0.3
- Update system prompt with VFB LLM guidance and improve MCP error handling

## v1.0.2
- Fix MCP server integration and improve error handling

## v1.0.1
- Dark mode implementation for VFB branding
