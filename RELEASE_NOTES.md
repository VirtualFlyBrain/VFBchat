# Release Notes

This file summarizes the release notes inferred from git tags (tag message/annotation). It is intended to preserve release history in the repository.

---

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
