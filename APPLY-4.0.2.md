# v4.0.2 — The conversation remembers what it resolved

A chat client that forgets, between one message and the next, which entity it was
talking about is not having a conversation — it is answering a series of unrelated
questions that happen to arrive in the same window. v4.0.2 closes that gap. Every
turn now carries a **minimized history** and the **resolved info** — the ids,
authoritative labels and query catalogue the session has already established — so
the second question about the medulla is answered by a client that knows what the
medulla is.

The trigger was a two-turn transcript from the live UI:

> **Q1** what is the medulla? → a correct answer, a working link, six Explore chips.
>
> **Q2** Which neurons receive output from the medulla? → *"The term "medulla" was
> not matched to a specific VFB entity in this session…"* — followed, in the same
> paragraph, by the exact counts for the medulla, and by no follow-ups at all.

Six distinct defects were behind those two turns. All six are fixed.

## 1. Context now crosses the turn boundary

`lib/conversationContext.mjs` is new. The server stays **stateless**: it returns a
merged `context` in the `result` event and the client echoes it back on the next
request, the same way it already echoes the message history. Because the client
echoes it, the context is **untrusted input** — `sanitizeContext` validates the
version, shape and every id before a single field is believed.

What travels is deliberately narrow: term ids, VFB's authoritative labels, and the
*names* of each term's available queries. **Counts do not travel.** A count is a
fact with an age, and an answer that quotes last turn's number as if it were this
turn's is a worse failure than one that has to fetch it again.

Alongside it, `minimizeHistory` runs deterministically on every turn — underneath
the LLM compaction, which only fires on very long conversations — so the planner
sees the shape of the conversation without paying for its full text.

## 2. A follow-on chip now carries the address it was built from

Every `kind:"ask"` chip is generated from an exact `(id, query_type)` pair — the
coordinates of the data it is promising. It used to emit neither, so clicking a
chip posted a sentence and the next turn had to re-derive from English the two
facts the chip already had in hand. When that re-derivation missed, you got the
"not matched to a specific VFB entity" opening about a term the session had
matched one turn earlier.

Chips now carry `id` and `query_type`, and a validated click becomes a
deterministic plan via `detectFocusPlan` — no planner call, no search, no guess.

## 3. The self-contradicting answer

The synthesiser could be told a name was unmatched while the ledger held its id.
`knownIdForName` / `unmatchedTermEntries` make that state unrepresentable: a name
the session has an id for is never described as unmatched.

## 4. "layer 7" is no longer a link

Count-linkification turned the bare numeral in "layer 7 (the serpentine layer)"
into a link to `?q=FBbt_00003748,LineageClonesIn` — a query about lineage clones,
attached to an anatomical layer number, because the digest happened to contain a 7.
`linkifyCounts` now requires the numeral to be doing a count's job before it will
link it.

## 5. The defect the fix created — and this is the interesting one

With context carried, turn 2 answered *better*: right id, right counts, named
neurons. And it offered **zero** follow-ups, where turn 1 offered six.

The cause is the feature's own success. Once the context block shows the planner
"medulla = FBbt_00003748", the planner stops putting the name in
`terms_to_resolve` — correct behaviour, and exactly what the block is for. But
then `resolveTerms` never runs, and `ledger.terms` ends the turn empty. Everything
deterministic that is built from resolved terms is then built from nothing:
follow-on chips, sources, term links. The best-informed turn in the conversation
was the one that dead-ended it.

The fix is a single idea: **a carried id re-enters the turn as a name to resolve,
not as a fact to trust.** `contextTermsNamedIn` finds the carried terms the
current question actually names, and hands them to the planner's resolve list. The
name then takes the existing `directId` short-circuit — no search, one term-info
fetch — so the digest and counts reaching the synthesiser are *this turn's*.
Adopting the carried digest wholesale would have been cheaper and wrong, for the
same reason counts do not travel in the context.

Matching is whole-word on both the user's earlier wording and VFB's own label, so
"the medulla" in turn 1 is found by "output from the medulla" in turn 2 while
"medullary" is not — and a label like `GAL4 (attP2)` matches itself rather than
throwing at a RegExp constructor.

## 6. A follow-on is an offer of something new

The live trace ended with "Which neurons receive output from the medulla?" offered
as a next step, directly beneath the answer to that exact question. Chips are now
suppressed for any `(id, query_type)` this turn actually ran, keyed by id as well
as type so a second region in the same answer keeps its own genuinely unasked
chips.

## Verified live

Against the Qwen 3.5 profile, end to end, both by typing and by clicking:

- turn 1 returns six chips, each carrying `FBbt_00003748` and a real `query_type`
- "layer 7" and "the seventh layer" stay plain text
- the merged context carries the id, ten queries and thirty-nine registry rows
  into turn 2, and the turn-2 planner reuses it without re-searching
- turn 2 now resolves the carried id (`adopt_context_terms` in the trace), answers
  with linked counts and named neurons, and offers follow-ups again
- the clicked-chip path answers in **28s** against 212s for the typed equivalent,
  because a validated chip skips planning entirely
- no "could not be matched" sentence in any run

910 unit tests pass. Every new branch was mutation-checked — the guard was removed
or inverted and a test was confirmed to fail.

## Also in this release

`/api/version` reports the resolved model, thinking mode and temperature for each
of the five roles, plus warnings and Node version, so a deployment can be checked
without a behavioural probe.

## A note on v4.0.1

The `v4.0.1` tag was cut and pushed against the v4.0.0 commit by mistake — a
release bundle whose ref was named `HEAD` rather than `main` meant the release
commit never reached the working clone, and the tag landed on what was still
there. Tags in this repository are protected and cannot be moved, so `v4.0.1` is
left in place as a duplicate of v4.0.0 and this release carries the work instead.
Nothing tagged `4.0.1` — including any container image built from that tag —
contains the changes described above. Use 4.0.2.
