# ADR 0002 — Scoped guidance, checked output, and where "skills" actually help

Status: proposed
Date: 2026-08-03
Context branch: `fix/remaining-workshop-tier`

## Context

The last four rounds of answer-quality work have all had the same shape. An
answer is wrong in a specific way, a sentence is added to the synthesiser's
prompt to correct it, and two or three unrelated question shapes change for the
worse. Concretely, and all observed in this repo:

- A licence to "name the remainder as a gap in VFB's documentation" fixed one
  answer and became a closing tic on four others.
- The same licence made the MCP configuration answer *drop* its `mcpServers`
  block, on two runs in three.
- The block-reproduction rule, stated unconditionally, fenced a support email
  address and a list of API section headings as if they were code.
- The available-data catalogue, supplied unconditionally, turned a fully scored
  and correct NBLAST answer into one that closed by reciting the follow-up
  queries already rendered as chips beside it.

The pattern is not that the rules are wrong. Each is right for the question it
was written for. The pattern is that **an instruction added for one question
shape is paid for by every other question shape**, because the synthesiser
prompt is assembled once, unconditionally, for all of them.

The proposal considered here is progressive disclosure — a "skills" approach,
where the model can call for further guidance depending on the task rather than
receiving everything up front.

## The mechanism already exists, and is scoped to the wrong things

`lib/guidanceCards.mjs` is exactly that design: eleven cards, each
`{ id, match(q), planner, synth? }`, whose text is injected **only when the
matcher fires**. Its own header says so. `classifyComplexity()` routes effort
off the same matchers — three planner votes and 24 tool rounds for a
connectivity or scRNAseq question, one vote and 10 rounds for a plain lookup.

So the question is not whether to adopt progressive disclosure. It is why the
rules that keep bleeding are not going through it. Two reasons, both fixable:

1. **The cards only cover topic routing.** Every block that has bled —
   `closingRule`, `docBlock`, `docMissBlock`, `availableBlock`, `unmatchedAdvice` —
   is hardcoded unconditionally in `synthesise()` (`lib/orchestrator.mjs:948–1113`),
   outside the card system entirely.
2. **`match` only sees the question string.** The bleeding blocks do not key on
   wording. They key on ledger state: `docAnswered`, `copyable`, `answeredAStep`,
   unmatched-with-candidates. No card can currently see any of that.

There is a third symptom worth naming because it is the strongest evidence that
the team already knows the prompt cannot hold this: `sanitizeInternalToolMentions`
(`app/api/chat/route.js:692–889`) is **188 chained `.replace()` calls**, of which
only about 42 are genuine internal-vocabulary cleanup. The rest are style and
phrasing bandages applied after the fact — and question-specific subjects have
leaked into them (`Hemibrain` ×4, `mushroom body` ×2, `fru+ mAL` ×1). That is a
verifier, implemented as find-and-replace, with no test naming what any rule is
for.

## Decision

Three layers, with a hard line between what code decides and what the model
decides.

### 1. Ledger-aware guidance cards (code-selected)

Widen the card signature to `match(question, ledger)` and move the answer-shape
rules into cards: the documentation block, the documentation-miss block, the
copyable-block instruction, the available-data catalogue, and the three-way
unmatched advice. Each becomes a card with an explicit matcher over the ledger
facts it actually depends on, instead of an `if` buried in a 165-line function.

This is the change that fixes the observed defects, and it changes no behaviour
on its own — it relocates existing conditions to a place where they are named,
individually testable, and visible as a set.

### 2. A checked-output layer (code-selected, post-hoc)

Replace the 188-rule sanitiser with named checks, each a
`{ id, detect(text, ledger), repair(text) }` with its own test and its own
recorded reason. `lib/fencedBlockRepair.mjs` already does this correctly for one
case — `isInternalRecord` / `createFenceRepairer` — and is the precedent.

The distinction that matters: a *prompt rule* asks the model not to do something
and is paid for by every question. A *check* looks at what came out and only
costs anything when the thing actually happened. Every rule in the sanitiser
that is really a check should be one; the handful that are genuine vocabulary
substitutions can stay as substitutions, with `sentenceStart()` used for any
that swap a whole sentence (see `lib/sentenceRewrite.mjs`).

Note that synthesis is **streamed**, so this layer must be in-stream, as
`createFenceRepairer` already is. There is no "afterwards" to run a tidy-up pass
in.

### 3. Model-callable skills, for retrieval only

Where the model genuinely should choose is retrieval: which page to read, which
query to run, whether to look somewhere else. A wrong choice there costs
latency and gets corrected by the next loop iteration.

**Style and answer-shape guidance should not be model-selected**, and this is
the one place the proposal is worth pushing back on:

- Correctness would come to depend on the intent classifier, which is this
  system's documented weakest link. It classifies "How do I connect Claude to the
  MCP server?" as `intent: connectivity`, and does not classify "When did X
  become available on VFB?" as `documentation`. This is why the codebase already
  uses question-grammar predicates (`isAboutVfbItself`, `needsDocumentation`,
  `isGeneExpressionQuestion`) instead of intent checks.
- The planner is already nondeterministic on the same question — three to four
  runs to reproduce a resolve defect, and the doc extractor gave three different
  answers to one page on three runs. Adding another model-made choice multiplies
  that.
- Synthesis is streamed, so a mid-stream call for guidance is not free: it means
  a pre-pass round trip on every answer.
- It weakens the task battery, which is the only end-to-end quality signal we
  have, by multiplying the state space it would have to cover.

Deterministic selection keeps the same benefit — the model sees a short,
on-point prompt — without making the routing itself a thing that can be wrong in
a new way.

## Consequences

- The synthesiser prompt for a plain anatomy question shrinks to the question,
  the entities, the evidence and the closing rule. That shape is now pinned by
  `tests/unit/synthPromptSurface.test.mjs`, which asserts as a negative matrix
  which blocks reach which question and ledger shape. A rule that widens fails a
  unit test instead of surfacing three battery runs later.
- Adding a rule becomes: write the matcher, add a row to the matrix, state what
  it must be absent from. The cost of a new rule stops being invisible.
- Some residuals are **not** prompt problems at all and this ADR does not claim
  to fix them. D20 (the FANC CATMAID question) is a retrieval problem: no prompt
  reaches a page the index cannot find. This ADR originally recorded the fix as
  "capturing each page's `<title>` and meta description at discovery time".
  **That was measured and found insufficient.** Across the real 96-page corpus,
  document frequency for `fafb` and `fanc` over title + meta description +
  headings is **zero** — the page that answers D20,
  `/docs/data/em/`, names them only in a comparison table and a bulleted list.
  The actual diagnosis is four compounding causes, all now fixed in
  `lib/reviewedDocsSearch.js` and pinned by tests:
  1. **An unanchored regex**, the largest single cause. `/\/data\//` in
     `BLOCKED_PAGE_PATH_PATTERNS` was meant to exclude a top-level asset
     directory and excluded the whole `/docs/data/` tree — seven pages,
     including the one that answers D20. Anchored to `/^\/data\//`.
  2. **Ranking on placeholders.** `rankEntries` ran before `enrichSearchResult`,
     which fetched real pages only for the three entries that had already won.
     Enrichment was cosmetic: it improved what was displayed, never what was
     found. The index is now enriched in the background behind the placeholder
     index, so the cold first query is unchanged.
  3. **Index dilution.** 91 of 187 discovered URLs were readthedocs
     `/en/vX.Y.Z/` archives — near-duplicate stale copies that pushed the
     document frequency of every vfb-connect term above ninety, driving its
     weight to the floor and so actively suppressing vfb-connect pages for
     vfb-connect questions. Excluded; `/en/stable/` and `/en/latest/` survive.
  4. **The extractor dropped the data carriers.** `extractContentBlocks` read
     only `h1`-`h3`, `p` and `pre`. It now reads `<tr>` a row at a time (cells
     joined with `" | "`) always, and `<li>` inside an isolated
     `<main>`/`role="main"` region with `nav`/`aside`/`header`/`footer`
     removed — which is what makes `<li>` safe to read at all, given a docs page
     carries 400-1300 of them and nearly all are menu links.
  Body text is indexed as the weakest scored field (1, against a title's 6), so
  a passing mention cannot outrank a page that is about the word; it earns its
  keep through the coverage multiplier instead. Verified end to end: D20 now
  ranks `/docs/data/em` first, where it previously ranked `/about/accessibility`
  first and never returned the answering page at all.
- T2.7 was recorded here as one wording bug. **That diagnosis was wrong**, and
  the correction is worth keeping because it is the same mistake this ADR is
  about: a defect in the answer was read as a defect in the prompt. T2.7 asks
  whether anything in the Hemibrain dataset resembles the fru+ mAL neurons, and
  answered that neither name could be matched. Probing VFB's own `/search`
  showed **four** faults, of which only the last is about wording, and all four
  are now fixed in `lib/orchestrator.mjs` and pinned by
  `tests/unit/nameVariants.test.mjs`:
  1. **Datasets were inadmissible.** `validSearchDocs` accepted a document only
     if its short_form began with an ontology prefix. VFB's dataset ids do not
     (`Xu2020NeuronsV1point2point1`), so every dataset was dropped before
     ranking — they could not be resolved, and could not even be offered as
     candidates. `isResolvableVfbDoc` now admits an ontology id, an `Entity`
     facet, or a `virtualflybrain.org/reports/` id, and `searchCandidateLabels`
     shares it instead of carrying its own copy of the rule.
  2. **One retry, of one shape.** The resolver retried a name only by
     singularising it, and only when the search came back empty. `fru+ mAL
     neurons` returns 33 rows — all gene records, `SMC6` and `nonC`, because the
     `+` poisons the Solr query — so it was never retried, while `fru mAL
     neuron` returns 305 rows with the right term first. `nameVariants` now
     produces an ordered ladder (singular, marker-stripped, both, category-noun
     stripped) and the retry fires whenever the search yields **no id**, not
     only when it yields no rows. A variant is still only adopted if it resolves
     under the *original* name, which is what keeps the 37 junk rows out.
  3. **A category noun names a facet, not a word in a label.** "Hemibrain
     dataset" returns 0 rows; "Hemibrain" returns 440, with the two real
     `DataSet` records ranked 436th and 439th — last. Every stage of the ladder
     was therefore guaranteed to answer with the wrong *kind* of record: the
     top-hit fallback returned `AB(R) on JRC_FlyEM_Hemibrain`, a synaptic
     neuropil domain, on a shared token. A new stage decides category
     references outright — the unique facet match, or nothing — and never falls
     through. Both Hemibrain datasets are legitimately "the Hemibrain dataset",
     so it abstains and offers *them* as the candidates. A confident answer
     about the wrong kind of record is worse than no answer.
  4. **The wording.** This part of the original diagnosis stands. The two
     `unmatched` branches were mergeable, so the model reported "candidates
     including no exact matches" about a name that had none. The empty branch
     now denies the candidate slot in terms ("There is NO candidate list for
     this name"), and a separate instruction forbids merging two unmatched
     names — gated on there being two, so a single-name question does not pay
     for it.
  The general lesson for this ADR: the prompt was the only place anyone had
  been looking, and three of the four faults were upstream of it, in what the
  ledger was allowed to contain. A rule added to the synthesiser could not have
  fixed any of them, and would have been paid for by every other question.

## Status of the work

Landed on this branch:

- `tests/unit/synthPromptSurface.test.mjs` — the negative matrix (8 tests).
- `lib/guidanceCards.mjs` — the connectivity card stands down for the software
  sense of "connect", found by writing the matrix. It was firing on "How do I
  connect Claude to the VFB MCP server?" and promoting a documentation question
  to the complex tier: three planner votes, 24 tool rounds.
- `lib/sentenceRewrite.mjs` — `sentenceStart()`, for any rewrite rule that
  substitutes a whole sentence.
- `lib/reviewedDocsSearch.js` — the four retrieval fixes for D20, with
  `tests/unit/reviewedDocsRanking.test.mjs` and
  `tests/unit/reviewedDocsPage.test.mjs`.
- `lib/orchestrator.mjs` — the four resolver fixes for T2.7, with
  `tests/unit/nameVariants.test.mjs` (24 tests).
- `lib/planner.mjs` — the fast path drops a leading indefinite article, so
  "What is a Kenyon cell?" resolves `Kenyon cell`. Lowercase-only, because `AN`
  is the abbreviation for ascending neuron.

Not yet done: layers 1 and 2 above.
